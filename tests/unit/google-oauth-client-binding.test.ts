import assert from "node:assert";
import { test } from "node:test";

// A Google refresh token is bound to the OAuth client that issued it. When an
// operator overrides ANTIGRAVITY_OAUTH_CLIENT_ID/SECRET with their own web
// client, existing connections (issued by the built-in desktop client) must
// keep refreshing against the built-in credentials, and only connections
// created under the custom client should refresh against the custom one.
// Regression: 2026-08-30, switching env credentials globally made every
// existing antigravity/agy refresh return 401 unauthorized_client.
import { getAccessToken } from "../../open-sse/services/tokenRefresh.ts";
import type { GoogleOauthClientMarker } from "../../open-sse/services/tokenRefresh/googleClientBinding.ts";
import { selectGoogleRefreshClient } from "../../open-sse/services/tokenRefresh/googleClientBinding.ts";
import { resolvePublicCred } from "../../open-sse/utils/publicCreds.ts";
import { PROVIDERS } from "../../open-sse/config/constants.ts";
import {
  recordRotation,
  _clearTokenRotationMap,
} from "../../open-sse/services/tokenRefresh/rotationMap.ts";

const CUSTOM_ID = "custom-client-id.apps.googleusercontent.com";

let enterpriseAttempt = 0;
async function enterpriseRefresh(marker: unknown) {
  const forms: URLSearchParams[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    forms.push(new URLSearchParams(String(init?.body)));
    return Response.json({ access_token: "synthetic-refreshed-access", expires_in: 3600 });
  };
  const refreshToken = `synthetic-enterprise-refresh-${++enterpriseAttempt}`;
  try {
    const result = await getAccessToken(
      "agy-enterprise",
      {
        refreshToken,
        providerSpecificData: { oauthClient: marker },
      },
      { warn() {}, info() {}, error() {} }
    );
    return { result, forms, refreshToken };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("Enterprise refresh uses issuing client", async () => {
  const id = resolvePublicCred("agy_enterprise_id", "AGY_ENTERPRISE_OAUTH_CLIENT_ID");
  const { result, forms, refreshToken } = await enterpriseRefresh(`custom:${id}`);
  assert.equal(result.accessToken, "synthetic-refreshed-access");
  assert.equal(forms.length, 1);
  assert.equal(forms[0].get("grant_type"), "refresh_token");
  assert.equal(forms[0].get("refresh_token"), refreshToken);
  assert.equal(forms[0].get("client_id"), id);
  assert.equal(
    forms[0].get("client_secret"),
    resolvePublicCred("agy_enterprise_alt", "AGY_ENTERPRISE_OAUTH_CLIENT_SECRET")
  );
  assert.notEqual(forms[0].get("client_id"), resolvePublicCred("antigravity_id"));
});

test("legacy Enterprise requires reauthorization without network", async () => {
  for (const marker of [undefined, "builtin", "custom", "custom:", 42, null]) {
    const { result, forms } = await enterpriseRefresh(marker);
    assert.deepEqual(result, {
      error: "unrecoverable_refresh_error",
      code: "enterprise_oauth_reauthorization_required",
    });
    assert.equal(forms.length, 0);
  }
});

test("Enterprise issuer validation cannot be bypassed by a cached rotation", async () => {
  const token = "synthetic-cached-enterprise-refresh";
  recordRotation("agy-enterprise", token, {
    accessToken: "cached-access",
    refreshToken: "rotated-refresh",
  });
  try {
    assert.deepEqual(
      await getAccessToken(
        "agy-enterprise",
        { refreshToken: token, providerSpecificData: { oauthClient: "builtin" } },
        null
      ),
      { error: "unrecoverable_refresh_error", code: "enterprise_oauth_reauthorization_required" }
    );
  } finally {
    _clearTokenRotationMap();
  }
});

test("rotated Enterprise issuer never falls back", async () => {
  const config = PROVIDERS["agy-enterprise"];
  const original = config.clientId;
  const originalSecret = config.clientSecret;
  try {
    config.clientId = "rotated-enterprise-client";
    config.clientSecret = "rotated-enterprise-secret";
    const { result, forms } = await enterpriseRefresh(
      `custom:${resolvePublicCred("agy_enterprise_id")}`
    );
    assert.deepEqual(result, {
      error: "unrecoverable_refresh_error",
      code: "enterprise_oauth_reauthorization_required",
    });
    assert.equal(forms.length, 0);
    const configured = await enterpriseRefresh("custom:rotated-enterprise-client");
    assert.equal(configured.forms[0].get("client_id"), "rotated-enterprise-client");
    assert.equal(configured.forms[0].get("client_secret"), "rotated-enterprise-secret");
    assert.throws(
      () =>
        selectGoogleRefreshClient("agy-enterprise", "custom:rotated-enterprise-client", {
          clientId: "rotated-enterprise-client",
          clientSecret: "",
        }),
      /issuing OAuth client is unavailable/
    );
  } finally {
    config.clientId = original;
    config.clientSecret = originalSecret;
  }
});

async function captureRefreshCall(
  providerOverridePsd?: { oauthClient?: GoogleOauthClientMarker } & Record<string, unknown>,
  provider = "antigravity"
) {
  const calls = [];
  // refreshGoogleToken reads PROVIDERS[provider].clientId from
  // ../config/constants.ts. The registry resolves the built-in desktop client
  // unless env overrides exist; point the env at the "custom" client so the
  // captured refresh reports which one the code actually used.
  const realId = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
  const realSecret = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
  process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = CUSTOM_ID;
  process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = "custom-secret";
  // Registry configuration is resolved once. Change the resolved fixture explicitly,
  // so these tests do not depend on which provider initializes the lazy registry first.
  const config = PROVIDERS[provider];
  const savedConfig = { clientId: config.clientId, clientSecret: config.clientSecret };
  if (provider === "antigravity") {
    config.clientId = CUSTOM_ID;
    config.clientSecret = "custom-secret";
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("oauth2.googleapis.com/token")) {
      const body = new URLSearchParams(init.body);
      calls.push({ client_id: body.get("client_id"), client_secret: body.get("client_secret") });
    }
    return {
      ok: true,
      json: async () => ({ access_token: "at", expires_in: 3600, refresh_token: undefined }),
      text: async () => "{}",
    };
  };
  try {
    await getAccessToken(
      provider,
      {
        connectionId: "test-conn",
        refreshToken: "rt",
        accessToken: null,
        providerSpecificData: providerOverridePsd,
      },
      { warn() {}, info() {}, error() {} }
    );
  } finally {
    Object.assign(config, savedConfig);
    globalThis.fetch = realFetch;
    if (realId === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_ID;
    else process.env.ANTIGRAVITY_OAUTH_CLIENT_ID = realId;
    if (realSecret === undefined) delete process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET;
    else process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET = realSecret;
  }
  return calls;
}

test("existing connection without oauthClient marker refreshes with the built-in client", async () => {
  const calls = await captureRefreshCall(undefined);
  assert.equal(calls.length, 1);
  // The built-in client is the masked constant decoded at runtime; asserting
  // it is NOT the env-configured custom client is the behavioral contract.
  assert.notEqual(calls[0].client_id, CUSTOM_ID);
  assert.ok(calls[0].client_id.endsWith(".apps.googleusercontent.com"));
});

test("connection marked oauthClient=builtin refreshes with the built-in client", async () => {
  const calls = await captureRefreshCall({ oauthClient: "builtin" });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].client_id, CUSTOM_ID);
  assert.ok(calls[0].client_id.endsWith(".apps.googleusercontent.com"));
});

test("connection marked oauthClient=custom:<id> matching the configured client refreshes with it", async () => {
  const calls = await captureRefreshCall({ oauthClient: `custom:${CUSTOM_ID}` });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].client_id, CUSTOM_ID);
});

test("custom-marked connection falls back to builtin after the operator rotates the custom client", async () => {
  // The marker stores the LITERAL issuing client id. When the operator swaps
  // to a different custom client, the old connection's token belongs to a
  // client neither the env nor the embedded default can represent — the
  // builtin fallback is chosen (and the refresh will fail with 401, which is
  // the honest outcome: that connection needs re-authorization).
  const calls = await captureRefreshCall({
    oauthClient: "custom:rotated-away-id.apps.googleusercontent.com",
  });
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].client_id, CUSTOM_ID);
  assert.ok(calls[0].client_id.endsWith(".apps.googleusercontent.com"));
});

test("gemini connection without a marker refreshes with the gemini builtin client", async () => {
  // gemini embeds a DIFFERENT desktop client than antigravity; the fallback
  // must be keyed by provider or every pre-existing gemini connection would
  // suddenly refresh against the antigravity client (401 unauthorized_client).
  // This also exercises the env-override interplay verified live: with
  // GEMINI_OAUTH_CLIENT_ID set to a custom client, an unmarked gemini
  // connection still refreshes against the gemini builtin.
  const realGeminiId = process.env.GEMINI_OAUTH_CLIENT_ID;
  const realGeminiSecret = process.env.GEMINI_OAUTH_CLIENT_SECRET;
  process.env.GEMINI_OAUTH_CLIENT_ID = "fake-custom-gemini-id.apps.googleusercontent.com";
  process.env.GEMINI_OAUTH_CLIENT_SECRET = "fake-secret";
  try {
    const calls = await captureRefreshCall(undefined, "gemini");
    assert.equal(calls.length, 1);
    assert.notEqual(calls[0].client_id, "fake-custom-gemini-id.apps.googleusercontent.com");
    assert.ok(calls[0].client_id.endsWith(".apps.googleusercontent.com"));
    const agyCalls = await captureRefreshCall(undefined, "antigravity");
    assert.notEqual(
      calls[0].client_id,
      agyCalls[0].client_id,
      "gemini and antigravity built-ins differ"
    );
  } finally {
    if (realGeminiId === undefined) delete process.env.GEMINI_OAUTH_CLIENT_ID;
    else process.env.GEMINI_OAUTH_CLIENT_ID = realGeminiId;
    if (realGeminiSecret === undefined) delete process.env.GEMINI_OAUTH_CLIENT_SECRET;
    else process.env.GEMINI_OAUTH_CLIENT_SECRET = realGeminiSecret;
  }
});
