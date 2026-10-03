import test from "node:test";
import assert from "node:assert/strict";
import { handleEnterpriseOAuth } from "../../src/lib/oauth/enterpriseSetup.ts";
import { getProviderConnections, getProviderConnectionById } from "../../src/lib/db/providers.ts";
import { enterprisePendingSetup } from "../../src/lib/oauth/enterprisePendingSetup.ts";
import {
  fetchEnterpriseLicenses,
  assignEnterpriseLicense,
} from "../../open-sse/services/agyEnterprise.ts";

test("license discovery matches the captured Enterprise request without assignment", async (t) => {
  const calls: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Response.json({ licenses: [] });
  });
  await fetchEnterpriseLicenses("synthetic-access");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://businessaicode.googleapis.com/v1beta:fetchLicenses");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].body, null);
  assert.equal(calls[0].headers.get("Authorization"), "Bearer synthetic-access");
  assert.equal(
    calls[0].headers.get("User-Agent"),
    "antigravity/cli/1.2.14 (aidev_client; os_type=windows; arch=amd64; cl=990662481; auth_method=gcp)"
  );
});

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
  let licensesFail = true;
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
    if (url.endsWith(":fetchLicenses") && licensesFail)
      return Response.json({ error: "private license failure" }, { status: 403 });
    if (url.endsWith(":selfAssignLicense"))
      return Response.json({
        license: { projectId: "project-one", location: "us", userTier: "standard" },
      });
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
  assert.equal(auth.codeVerifier, undefined);
  assert.equal(new URL(auth.authUrl).searchParams.get("code_challenge_method"), "S256");
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
  assert.match(await failed.text(), /synthetic private upstream error/);
  infoFails = false;
  const partial = await handleEnterpriseOAuth(
    request(`licenses?setupId=${setup.setupId}`, owner),
    "licenses"
  );
  assert.equal(partial.status, 200);
  const partialData = await partial.json();
  assert.equal(partialData.email, "person@example.com");
  assert.match(partialData.discoveryError, /403/);
  assert.match(partialData.discoveryError, /private license failure/);
  const retry = await handleEnterpriseOAuth(
    request(`licenses?setupId=${setup.setupId}`, owner),
    "licenses"
  );
  assert.equal((await retry.json()).email, "person@example.com");
  assert.equal(
    calls.some((url) => url.includes(":selfAssignLicense")),
    false
  );
  assert.equal(calls.filter((url) => url.includes("oauth2.googleapis.com/token")).length, 1);
  const custom = await handleEnterpriseOAuth(
    request("verify-project", owner, { setupId: setup.setupId, projectId: "project-one" }),
    "verify-project"
  );
  assert.equal(custom.status, 200);
  const customData = await custom.json();
  assert.equal(customData.verifiedLicenseId, customData.licenses[0].licenseId);
  licensesFail = false;
  const discovery = await handleEnterpriseOAuth(
    request(`licenses?setupId=${setup.setupId}`, owner),
    "licenses"
  );
  const licenses = (await discovery.json()).licenses;
  assert.equal(licenses[1].supported, true);
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

test("EU manual verification pins assignment and config to the selected region", async (t) => {
  let wrongContext = true;
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("oauth2.googleapis.com/token"))
      return Response.json({ access_token: "synthetic-access", expires_in: 3600 });
    if (url.includes("oauth2/v2/userinfo"))
      return Response.json({ id: "eu-subject", email: "eu@example.com", verified_email: true });
    if (url.endsWith(":fetchLicenses")) return Response.json({ licenses: [] });
    if (url.endsWith(":selfAssignLicense")) {
      assert.equal(
        url,
        "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/project-one/locations/eu:selfAssignLicense"
      );
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        parent: "projects/project-one/locations/eu",
      });
      return Response.json({
        license: {
          projectId: "project-one",
          location: wrongContext ? "us" : "eu",
          userTier: "standard",
        },
      });
    }
    assert.equal(
      url,
      "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/project-one/locations/eu:fetchConfig?entitlement.userTier=standard"
    );
    return Response.json({ adminControls: {} });
  });
  const authorized = await handleEnterpriseOAuth(request("authorize"), "authorize");
  const owner = authorized.headers.get("set-cookie")!.split(";")[0];
  const auth = await authorized.json();
  const exchange = await handleEnterpriseOAuth(
    request("exchange", owner, {
      code: "synthetic",
      redirectUri: auth.redirectUri,
      state: auth.state,
    }),
    "exchange"
  );
  const { setupId } = await exchange.json();
  await handleEnterpriseOAuth(request(`licenses?setupId=${setupId}`, owner), "licenses");
  assert.equal(
    calls.some((url) => url.includes(":selfAssignLicense")),
    false
  );
  const body = { setupId, projectId: "project-one", location: "eu" };
  const mismatch = await handleEnterpriseOAuth(
    request("verify-project", owner, body),
    "verify-project"
  );
  assert.equal(mismatch.status, 400);
  wrongContext = false;
  const verified = await handleEnterpriseOAuth(
    request("verify-project", owner, body),
    "verify-project"
  );
  assert.equal(verified.status, 200);
  const selected = await verified.json();
  assert.equal(selected.licenses[0].location, "eu");
  const finalized = await handleEnterpriseOAuth(
    request("finalize", owner, {
      setupId,
      licenseId: selected.verifiedLicenseId,
      location: "us",
    }),
    "finalize"
  );
  assert.equal(finalized.status, 200);
  const row = await getProviderConnectionById((await finalized.json()).connectionId);
  assert.equal((row.providerSpecificData as Record<string, unknown>).location, "eu");
});

test("manual assignment rejects a returned license for another project", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      license: { projectId: "project-wrong", location: "us", userTier: "standard" },
    })
  );
  await assert.rejects(assignEnterpriseLicense("synthetic", "project-one", "us"), /context/);
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
