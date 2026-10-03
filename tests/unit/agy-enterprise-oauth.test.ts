import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { handleEnterpriseOAuth } from "../../src/lib/oauth/enterpriseSetup.ts";
import { AGY_ENTERPRISE_CONFIG } from "../../src/lib/oauth/constants/oauth.ts";
import { agyEnterprise } from "../../src/lib/oauth/providers/agy-enterprise.ts";
import {
  getProviderConnections,
  createProviderConnection,
  getProviderConnectionById,
} from "../../src/lib/db/providers.ts";
import { PROVIDERS } from "../../open-sse/config/constants.ts";

const origin = "http://localhost:20128";
function request(action: string, owner = "", body?: unknown) {
  return new Request(`${origin}/api/oauth/agy-enterprise/${action}`, {
    method: body ? "POST" : "GET",
    headers: { Origin: origin, Cookie: owner, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function authorize() {
  const response = await handleEnterpriseOAuth(
    request("authorize?redirect_uri=https://foreign.example/callback"),
    "authorize"
  );
  assert.equal(response.status, 200);
  return { owner: response.headers.get("set-cookie")!.split(";")[0], data: await response.json() };
}
const tokenResponse = () =>
  Response.json({
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
  });

test("personal OAuth overrides do not select the Enterprise client", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { AGY_ENTERPRISE_CONFIG } from './src/lib/oauth/constants/oauth.ts';
    import { PROVIDERS } from './open-sse/config/constants.ts';
    assert.ok(AGY_ENTERPRISE_CONFIG.clientId.startsWith('884354919052-'));
    assert.equal(PROVIDERS['agy-enterprise'].clientId, AGY_ENTERPRISE_CONFIG.clientId);
    assert.notEqual(AGY_ENTERPRISE_CONFIG.clientSecret, 'personal-secret');
  `,
    ],
    {
      env: {
        ...process.env,
        ANTIGRAVITY_OAUTH_CLIENT_ID: "personal-client",
        ANTIGRAVITY_OAUTH_CLIENT_SECRET: "personal-secret",
        AGY_ENTERPRISE_OAUTH_CLIENT_ID: "",
        AGY_ENTERPRISE_OAUTH_CLIENT_SECRET: "",
      },
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0, result.stderr);
});

test("Enterprise authorize matches captured client/callback/scopes and retains PKCE server-side", async (t) => {
  const first = await authorize();
  const second = await authorize();
  const url = new URL(first.data.authUrl);
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/auth");
  assert.equal(url.searchParams.get("client_id"), AGY_ENTERPRISE_CONFIG.clientId);
  assert.ok(AGY_ENTERPRISE_CONFIG.clientId.startsWith("884354919052-"));
  assert.equal(url.searchParams.get("redirect_uri"), "https://antigravity.google/oauth-callback");
  assert.equal(first.data.redirectUri, "https://antigravity.google/oauth-callback");
  assert.equal(
    url.searchParams.get("scope"),
    ["cloud-platform", "userinfo.email", "userinfo.profile", "cclog", "experimentsandconfigs"]
      .map((scope) => `https://www.googleapis.com/auth/${scope}`)
      .concat("openid")
      .join(" ")
  );
  for (const [key, value] of Object.entries({
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    code_challenge_method: "S256",
  }))
    assert.equal(url.searchParams.get(key), value);
  assert.equal(first.data.codeVerifier, undefined);
  assert.notEqual(first.data.state, second.data.state);
  assert.notEqual(
    url.searchParams.get("code_challenge"),
    new URL(second.data.authUrl).searchParams.get("code_challenge")
  );
  assert.equal(PROVIDERS["agy-enterprise"].clientId, AGY_ENTERPRISE_CONFIG.clientId);
  assert.equal(PROVIDERS["agy-enterprise"].clientSecret, AGY_ENTERPRISE_CONFIG.clientSecret);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(input), "https://oauth2.googleapis.com/token");
    assert.equal(
      new Headers(init?.headers).get("content-type"),
      "application/x-www-form-urlencoded"
    );
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get("code"), "synthetic-code");
    assert.equal(form.get("client_id"), AGY_ENTERPRISE_CONFIG.clientId);
    assert.equal(form.get("client_secret"), AGY_ENTERPRISE_CONFIG.clientSecret);
    assert.equal(form.get("redirect_uri"), "https://antigravity.google/oauth-callback");
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(
      createHash("sha256").update(form.get("code_verifier")!).digest("base64url"),
      url.searchParams.get("code_challenge")
    );
    return tokenResponse();
  });
  const response = await handleEnterpriseOAuth(
    request("exchange", first.owner, {
      code: " synthetic-code ",
      state: first.data.state,
      codeVerifier: "attacker-verifier",
      redirectUri: "https://foreign.example",
    }),
    "exchange"
  );
  assert.equal(response.status, 200);
  const pending = await response.json();
  assert.equal(pending.status, "pending");
  assert.equal(JSON.stringify(pending).includes("synthetic-access"), false);
  const mapped = agyEnterprise.mapTokens(await tokenResponse().json());
  assert.equal(mapped.providerSpecificData.oauthClient, `custom:${AGY_ENTERPRISE_CONFIG.clientId}`);
  assert.equal(mapped.providerSpecificData.clientProfile, "cli");
});

test("authorization is owner-bound and expires", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return tokenResponse();
  });
  const { owner, data } = await authorize();
  for (const [cookie, state] of [
    [`enterprise_setup_owner=${"a".repeat(64)}`, data.state],
    [owner, "unknown-state"],
  ]) {
    const response = await handleEnterpriseOAuth(
      request("exchange", cookie, { code: "synthetic", state }),
      "exchange"
    );
    assert.equal(response.status, 400);
  }
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 15 * 60 * 1000 + 1);
  assert.equal(
    (
      await handleEnterpriseOAuth(
        request("exchange", owner, { code: "synthetic", state: data.state }),
        "exchange"
      )
    ).status,
    400
  );
  assert.equal(calls, 0);
});

test("concurrent exchange consumes authorization once", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return tokenResponse();
  });
  const target = await createProviderConnection({
    provider: "agy-enterprise",
    authType: "oauth",
    email: "reauth@example.com",
    projectId: "project-one",
    accessToken: "existing-access",
    providerSpecificData: { projectId: "project-one", location: "us", userTier: "standard" },
  });
  for (const connectionId of [undefined, target.id]) {
    const { owner, data } = await authorize();
    const before = calls;
    const responses = await Promise.all(
      [1, 2].map(() =>
        handleEnterpriseOAuth(
          request("exchange", owner, { code: "synthetic", state: data.state, connectionId }),
          "exchange"
        )
      )
    );
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 400]);
    assert.equal(calls - before, 1);
  }
  assert.equal((await getProviderConnectionById(target.id)).accessToken, "existing-access");
});

test("foreign code fails PKCE and cannot create setup or connection", async (t) => {
  const before = (await getProviderConnections({ provider: "agy-enterprise" })).length;
  const { owner, data } = await authorize();
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: "invalid_grant", error_description: "PKCE verification failed" },
      { status: 400 }
    )
  );
  const result = await handleEnterpriseOAuth(
    request("exchange", owner, { code: "foreign-code", state: data.state }),
    "exchange"
  );
  assert.equal(result.status, 400);
  const body = await result.json();
  assert.match(body.error, /invalid_grant.*PKCE verification failed/);
  assert.match(body.error, /Start Google sign-in again/);
  assert.equal(body.setupId, undefined);
  assert.equal((await getProviderConnections({ provider: "agy-enterprise" })).length, before);
  assert.equal(
    (
      await handleEnterpriseOAuth(
        request("exchange", owner, { code: "synthetic", state: data.state }),
        "exchange"
      )
    ).status,
    400
  );
});

test("Enterprise exchange rejects issuer rotation and invalid reauthorization target without network", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return tokenResponse();
  });
  const { owner, data } = await authorize();
  const target = await handleEnterpriseOAuth(
    request("exchange", owner, {
      code: "synthetic",
      state: data.state,
      connectionId: "11111111-1111-4111-8111-111111111111",
    }),
    "exchange"
  );
  assert.equal(target.status, 400);
  const original = AGY_ENTERPRISE_CONFIG.clientId;
  try {
    AGY_ENTERPRISE_CONFIG.clientId = "rotated-client";
    assert.match(
      await (
        await handleEnterpriseOAuth(
          request("exchange", owner, { code: "synthetic", state: data.state }),
          "exchange"
        )
      ).text(),
      /client changed/
    );
    assert.equal(calls, 0);
  } finally {
    AGY_ENTERPRISE_CONFIG.clientId = original;
  }
});

test("Enterprise token exchange diagnostics redact echoed credentials and stack paths", async (t) => {
  const { owner, data } = await authorize();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body));
    return Response.json(
      {
        error: "invalid_grant",
        error_description: [
          form.get("code"),
          form.get("code_verifier"),
          form.get("client_secret"),
          "at /private/app/file.ts:1:2",
        ].join(" "),
      },
      { status: 400 }
    );
  });
  const response = await handleEnterpriseOAuth(
    request("exchange", owner, { code: "opaque-secret-code", state: data.state }),
    "exchange"
  );
  const body = await response.text();
  assert.match(body, /HTTP 400.*invalid_grant/);
  for (const value of [
    "opaque-secret-code",
    AGY_ENTERPRISE_CONFIG.clientSecret,
    "/private/app/file.ts",
  ])
    assert.equal(body.includes(value), false);
});
