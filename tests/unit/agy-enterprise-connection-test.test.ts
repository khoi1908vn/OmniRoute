import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agy-enterprise-probe-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const { OAUTH_TEST_CONFIG } =
  await import("../../src/app/api/providers/[id]/test/oauthTestConfig.ts");
const { testOAuthConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");
const { AGY_ENTERPRISE_CONFIG } = await import("../../src/lib/oauth/constants/oauth.ts");
const { seedAntigravityCliVersionCache, clearAntigravityVersionCaches } =
  await import("../../open-sse/services/antigravityVersion.ts");

const context = { projectId: "project-one", location: "us", userTier: "standard" };
function connection(overrides: Record<string, unknown> = {}) {
  return {
    provider: "agy-enterprise",
    authType: "oauth",
    accessToken: "test-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    providerSpecificData: context,
    ...overrides,
  };
}

test.beforeEach(() => seedAntigravityCliVersionCache("1.2.16"));
test.after(() => {
  core.resetDbInstance();
  clearAntigravityVersionCaches();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Enterprise probe builds the minimal inference request", async () => {
  const config = OAUTH_TEST_CONFIG["agy-enterprise"];
  const probe = await config.buildProbe!(connection(), "fresh-token");
  assert.equal(probe.method, "POST");
  assert.equal(
    probe.url,
    "https://businessaicode.us.rep.googleapis.com/v1beta/projects/project-one/locations/us:streamGenerateContent?alt=sse"
  );
  assert.equal(probe.headers.Authorization, "Bearer fresh-token");
  assert.equal(probe.headers["Content-Type"], "application/json");
  assert.equal(probe.headers.Accept, "text/event-stream");
  assert.match(probe.headers["User-Agent"], /auth_method=gcp/);
  assert.match(probe.headers["X-Aicode-Request-Id"], /^checkpoint\//);
  assert.deepEqual(JSON.parse(probe.body!), {
    contents: [{ role: "user", parts: [{ text: "Explicitly reply with '1'" }] }],
    generationConfig: { maxOutputTokens: 8, temperature: 0 },
    aicode: { experience: "gemini-3.5-flash-lite" },
    entitlement: { userTier: "standard" },
  });
});

test("EU probe preserves saved license", async () => {
  const probe = await OAUTH_TEST_CONFIG["agy-enterprise"].buildProbe!(
    connection({ providerSpecificData: { ...context, location: "eu", userTier: "premium" } }),
    "eu-token"
  );
  assert.equal(
    probe.url,
    "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/project-one/locations/eu:streamGenerateContent?alt=sse"
  );
  assert.deepEqual(JSON.parse(probe.body!).entitlement, { userTier: "premium" });
});

test("invalid context sends no fetch", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null);
  });
  for (const providerSpecificData of [
    undefined,
    { projectId: "project-one", location: "us" },
    { ...context, projectId: "../unsafe" },
    { ...context, location: "unknown" },
  ]) {
    const result = await testOAuthConnection(connection({ providerSpecificData }));
    assert.equal(result.valid, false);
    assert.notEqual(result.error, "Provider test not supported");
  }
  assert.equal(calls, 0);
});

test("missing token sends no fetch", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return new Response(null);
  });
  assert.equal((await testOAuthConnection(connection({ accessToken: null }))).valid, false);
  assert.equal(calls, 0);
});

test("invalid context blocks expired-token refresh before any upstream request", async (t) => {
  const stored = await providersDb.createProviderConnection({
    ...connection(),
    projectId: context.projectId,
    email: "invalid-expired@example.com",
    refreshToken: "synthetic-refresh",
    expiresAt: new Date(0).toISOString(),
    providerSpecificData: {
      ...context,
      oauthClient: `custom:${AGY_ENTERPRISE_CONFIG.clientId}`,
    },
  });
  const before = await providersDb.getProviderConnectionById(stored.id);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json({ access_token: "unexpected-refresh", expires_in: 3600 });
  });
  for (const providerSpecificData of [
    undefined,
    { ...stored.providerSpecificData, userTier: undefined },
    { ...stored.providerSpecificData, projectId: "../unsafe" },
    { ...stored.providerSpecificData, location: "unknown" },
  ]) {
    const result = await testOAuthConnection({ ...stored, providerSpecificData });
    assert.equal(result.valid, false);
    assert.equal(result.refreshed, false);
    assert.equal(result.diagnosis?.source, "local");
    assert.equal(result.diagnosis?.code, "invalid_connection_context");
  }
  assert.equal(calls, 0);
  assert.deepEqual(await providersDb.getProviderConnectionById(stored.id), before);
});

test("accepted Enterprise probe returns valid", async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } });
  });
  const result = await testOAuthConnection(connection());
  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/businessaicode\.us\.rep\.googleapis\.com\//);
  assert.ok(calls[0].init?.signal);
});

for (const status of [400, 401, 403, 429, 500]) {
  test(`Enterprise HTTP ${status} preserves upstream status`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ error: {} }, { status }));
    const result = await testOAuthConnection(connection());
    assert.equal(result.valid, false);
    assert.equal(result.statusCode, status);
    assert.notEqual(result.error, "Provider test not supported");
  });
}

test("expired token refresh preserves license and issuer", async (t) => {
  const stored = await providersDb.createProviderConnection({
    ...connection(),
    projectId: context.projectId,
    email: "probe@example.com",
    refreshToken: "synthetic-refresh",
    expiresAt: new Date(0).toISOString(),
    providerSpecificData: {
      ...context,
      oauthClient: `custom:${AGY_ENTERPRISE_CONFIG.clientId}`,
    },
  });
  const calls: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url) === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get("client_id"), AGY_ENTERPRISE_CONFIG.clientId);
      assert.equal(form.get("client_secret"), AGY_ENTERPRISE_CONFIG.clientSecret);
      assert.equal(form.get("refresh_token"), "synthetic-refresh");
      return Response.json({ access_token: "refreshed-token", expires_in: 3600 });
    }
    assert.match(String(url), /^https:\/\/businessaicode\.us\.rep\.googleapis\.com\//);
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer refreshed-token");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.entitlement, { userTier: context.userTier });
    return new Response(null);
  });
  const result = await testOAuthConnection(stored);
  assert.equal(result.valid, true);
  assert.equal(result.refreshed, true);
  assert.equal(calls.length, 2);
  const persisted = await providersDb.getProviderConnectionById(stored.id);
  assert.equal(persisted?.accessToken, "refreshed-token");
  assert.deepEqual(persisted?.providerSpecificData, stored.providerSpecificData);
});

test("Enterprise timeout remains network failure", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
    await setTimeout(10);
    init?.signal?.throwIfAborted();
    throw new Error("expected abort");
  });
  const result = await testOAuthConnection(connection(), 1);
  assert.equal(result.valid, false);
  assert.match(result.error ?? "", /Test timed out/);
  assert.equal(result.diagnosis?.type, "network_error");
});

test("accepted Enterprise stream is cancelled", async (t) => {
  let cancelCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelCount++;
        },
      })
    );
  });
  const result = await testOAuthConnection(connection());
  assert.equal(result.valid, true);
  assert.equal(cancelCount, 1);
  assert.equal(result.refreshed, false);
});

for (const status of [400, 401, 403]) {
  test(`accepted stream after HTTP ${status} refresh is cancelled`, async (t) => {
    const stored = await providersDb.createProviderConnection({
      ...connection(),
      projectId: context.projectId,
      email: `retry-${status}@example.com`,
      refreshToken: `retry-${status}`,
      providerSpecificData: {
        ...context,
        oauthClient: `custom:${AGY_ENTERPRISE_CONFIG.clientId}`,
      },
    });
    let probes = 0;
    let refreshes = 0;
    let cancelCount = 0;
    t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        refreshes++;
        return Response.json({ access_token: `fresh-${status}`, expires_in: 3600 });
      }
      probes++;
      if (probes === 1) {
        // Token expires while the first probe is in flight, exercising the retry path.
        stored.expiresAt = new Date(0).toISOString();
        await providersDb.updateProviderConnection(stored.id, { expiresAt: stored.expiresAt });
        return Response.json({ error: {} }, { status });
      }
      assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer fresh-${status}`);
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelCount++;
          },
        })
      );
    });
    const result = await testOAuthConnection(stored);
    assert.equal(result.valid, true);
    assert.equal(result.refreshed, true);
    assert.equal(refreshes, 1);
    assert.equal(probes, 2);
    assert.equal(cancelCount, 1);
  });
}

test("accepted null body remains valid", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.equal((await testOAuthConnection(connection())).valid, true);
});

test("rejected stream cancellation does not change HTTP success", async (t) => {
  let cancelCount = 0;
  t.mock.method(globalThis, "fetch", async () => {
    return new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelCount++;
          throw new Error("private cancellation failure");
        },
      })
    );
  });
  const result = await testOAuthConnection(connection());
  assert.equal(result.valid, true);
  assert.equal(result.error, null);
  assert.equal(cancelCount, 1);
  assert.equal(JSON.stringify(result).includes("private cancellation failure"), false);
});
