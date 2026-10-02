import test from "node:test";
import assert from "node:assert/strict";
import { handleEnterpriseOAuth } from "../../src/lib/oauth/enterpriseSetup.ts";
import { getProviderConnections, getProviderConnectionById } from "../../src/lib/db/providers.ts";
import { enterprisePendingSetup } from "../../src/lib/oauth/enterprisePendingSetup.ts";

const base = "http://localhost:20128/api/oauth/agy-enterprise/";
function request(action: string, owner = "", body?: unknown, origin = "http://localhost:20128") {
  return new Request(`${base}${action}`, {
    method: body ? "POST" : "GET",
    headers: {
      Origin: origin,
      ...(owner ? { Cookie: owner } : {}),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("server setup keeps tokens pending across discovery failure, pins selected license and saves once", async (t) => {
  const calls: string[] = [];
  let infoFails = true;
  let configFails = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("oauth2.googleapis.com/token"))
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
      });
    if (url.includes("oauth2/v2/userinfo")) {
      if (infoFails)
        return Response.json({ error: "synthetic private upstream error" }, { status: 503 });
      return Response.json({
        id: "subject-one",
        email: "person@example.com",
        verified_email: true,
      });
    }
    if (url.endsWith(":fetchLicenses"))
      return Response.json({
        licenses: [
          { projectId: "project-one", location: "us", userTier: "standard" },
          { projectId: "project-one", location: "eu", userTier: "standard" },
        ],
      });
    if (url.includes(":fetchConfig")) {
      assert.match(
        url,
        /projects\/project-one\/locations\/us:fetchConfig\?entitlement.userTier=standard$/
      );
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-access");
      return configFails
        ? Response.json({ error: "secret upstream body" }, { status: 403 })
        : Response.json({ adminControls: {} });
    }
    throw new Error(`Unexpected upstream endpoint: ${url}`);
  });
  const authorize = await handleEnterpriseOAuth(
    request("authorize?redirect_uri=http://localhost:8080/callback"),
    "authorize"
  );
  assert.equal(authorize.status, 200);
  const owner = authorize.headers.get("set-cookie")!.split(";")[0];
  const auth = await authorize.json();
  const exchanged = await handleEnterpriseOAuth(
    request("exchange", owner, {
      code: "synthetic-code",
      redirectUri: auth.redirectUri,
      codeVerifier: auth.codeVerifier,
      state: auth.state,
    }),
    "exchange"
  );
  assert.equal(exchanged.status, 200);
  const setup = await exchanged.json();
  assert.equal(setup.status, "pending");
  assert.equal(JSON.stringify(setup).includes("synthetic-access"), false);
  assert.equal((await getProviderConnections({ provider: "agy-enterprise" })).length, 0);
  assert.equal(calls.length, 1);
  const stolen = await handleEnterpriseOAuth(
    request(`licenses?setupId=${setup.setupId}`, `enterprise_setup_owner=${"a".repeat(64)}`),
    "licenses"
  );
  assert.equal(stolen.status, 410);
  const failed = await handleEnterpriseOAuth(
    request(`licenses?setupId=${setup.setupId}`, owner),
    "licenses"
  );
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes("private upstream"), false);
  infoFails = false;
  const discovery = await handleEnterpriseOAuth(
    request(`licenses?setupId=${setup.setupId}`, owner),
    "licenses"
  );
  const licenses = (await discovery.json()).licenses;
  assert.equal(licenses[1].supported, false);
  const payload = {
    setupId: setup.setupId,
    licenseId: licenses[0].licenseId,
    projectId: "attacker-project",
    location: "eu",
    userTier: "injected",
  };
  const denied = await handleEnterpriseOAuth(request("finalize", owner, payload), "finalize");
  assert.equal(denied.status, 403);
  assert.equal((await getProviderConnections({ provider: "agy-enterprise" })).length, 0);
  configFails = false;
  const [first, duplicate] = await Promise.all([
    handleEnterpriseOAuth(request("finalize", owner, payload), "finalize"),
    handleEnterpriseOAuth(request("finalize", owner, payload), "finalize"),
  ]);
  const result = await first.json();
  assert.equal(first.status, 200);
  assert.deepEqual(await duplicate.json(), result);
  assert.equal((await getProviderConnections({ provider: "agy-enterprise" })).length, 1);
  const row = await getProviderConnectionById(result.connectionId);
  assert.equal(row.projectId, "project-one");
  assert.equal(row.expiresAt, row.tokenExpiresAt);
  assert.equal((row.providerSpecificData as Record<string, unknown>).googleSubject, "subject-one");
  const cancelled = await handleEnterpriseOAuth(
    request("cancel", owner, { setupId: setup.setupId }),
    "cancel"
  );
  assert.deepEqual(await cancelled.json(), result);
  assert.equal(
    calls.some((url) => /loadCodeAssist|onboardUser|fetchAvailableModels/.test(url)),
    false
  );
});

test("setup rejects foreign origins and malformed or unsupported sibling completion actions", async () => {
  const forbidden = await handleEnterpriseOAuth(
    request("authorize", "", undefined, "https://attacker.example"),
    "authorize"
  );
  assert.equal(forbidden.status, 403);
  const malformed = await handleEnterpriseOAuth(
    request("exchange", `enterprise_setup_owner=${"b".repeat(64)}`, {}),
    "exchange"
  );
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.text()).includes("at /"), false);
  assert.throws(() => enterprisePendingSetup.get("missing", "missing"));
});
