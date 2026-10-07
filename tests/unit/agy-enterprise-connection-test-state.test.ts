import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-agy-enterprise-test-state-"));
process.env.DATA_DIR = dataDir;
process.env.DISABLE_SQLITE_AUTO_BACKUP = "true";
process.env.OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK = "true";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const leases = await import("../../src/lib/db/exclusiveConnectionLeases.ts");
const { testSingleConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");
const { applyOperatorActivationIntent } =
  await import("../../src/lib/providers/operatorDisable.ts");
const { seedAntigravityCliVersionCache, clearAntigravityVersionCaches } =
  await import("../../open-sse/services/antigravityVersion.ts");

const context = { projectId: "project-one", location: "us", userTier: "standard" };
async function createConnection(name: string, overrides: Record<string, unknown> = {}) {
  return providersDb.createProviderConnection({
    provider: "agy-enterprise",
    authType: "oauth",
    name,
    email: `${name}@example.com`,
    projectId: context.projectId,
    accessToken: "synthetic-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    providerSpecificData: context,
    isActive: true,
    ...overrides,
  });
}

test.beforeEach(() => seedAntigravityCliVersionCache("1.2.16"));
test.after(() => {
  core.resetDbInstance();
  clearAntigravityVersionCaches();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Enterprise success clears stale test error", async (t) => {
  const stored = await createConnection("stale-error", { isActive: false });
  await providersDb.updateProviderConnection(stored.id, {
    testStatus: "error",
    lastError: "old upstream error",
    lastErrorType: "network_error",
    lastErrorAt: new Date(0).toISOString(),
    rateLimitedUntil: new Date(0).toISOString(),
    backoffLevel: 2,
  });
  assert.equal(
    (await providersDb.getProviderConnectionById(stored.id))?.lastError,
    "old upstream error"
  );
  t.mock.method(globalThis, "fetch", async () => new Response(null));
  const result = await testSingleConnection(stored.id);
  assert.equal(result.valid, true);
  const updated = await providersDb.getProviderConnectionById(stored.id);
  assert.equal(updated?.isActive, true);
  assert.equal(updated?.testStatus, "active");
  assert.equal(updated?.lastError ?? null, null);
  assert.equal(updated?.lastErrorType ?? null, null);
  assert.equal(updated?.lastErrorAt ?? null, null);
  assert.equal(updated?.rateLimitedUntil ?? null, null);
  assert.equal(updated?.backoffLevel, 0);
});

test("Enterprise failure preserves active state and sibling", async (t) => {
  const stored = await createConnection("limited");
  const sibling = await createConnection("sibling");
  const before = await providersDb.getProviderConnectionById(sibling.id);
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: {} }, { status: 429 }));
  const result = await testSingleConnection(stored.id);
  assert.equal(result.valid, false);
  assert.equal(result.statusCode, 429);
  const updated = await providersDb.getProviderConnectionById(stored.id);
  assert.equal(updated?.isActive, true);
  assert.equal(updated?.testStatus, "error");
  assert.ok(new Date(String(updated?.rateLimitedUntil)).getTime() > Date.now());
  assert.deepEqual(await providersDb.getProviderConnectionById(sibling.id), before);
});

test("Enterprise test preserves operator disable during probe", async (t) => {
  const stored = await createConnection("disabled-inflight");
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.mock.method(globalThis, "fetch", async () => {
    entered();
    await gate;
    return new Response(null);
  });
  const inFlight = testSingleConnection(stored.id);
  try {
    await started;
    await providersDb.updateProviderConnection(stored.id, {
      isActive: false,
      providerSpecificData: applyOperatorActivationIntent(stored.providerSpecificData, false),
    });
  } finally {
    release();
  }
  assert.equal((await inFlight).valid, true);
  const updated = await providersDb.getProviderConnectionById(stored.id);
  assert.equal(updated?.isActive, false);
  assert.equal(typeof updated?.providerSpecificData?.operatorDisabledAt, "string");
});

test("exclusive lease skips Enterprise probe", async (t) => {
  const stored = await createConnection("leased");
  assert.equal(
    leases.acquireExclusiveConnectionLease({
      leaseOwnerId: `vlo_${"T".repeat(43)}`,
      apiKeyId: "synthetic-managed-key",
      provider: "agy-enterprise",
      connectionId: stored.id,
    }).kind,
    "ACQUIRED"
  );
  const before = await providersDb.getProviderConnectionById(stored.id);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    throw new Error("unexpected leased probe");
  });
  const result = await testSingleConnection(stored.id);
  assert.equal(result.valid, false);
  assert.equal(result.skipped, true);
  assert.equal(result.diagnosis?.code, "exclusive_lease_active");
  assert.equal(calls, 0);
  assert.deepEqual(await providersDb.getProviderConnectionById(stored.id), before);
});
