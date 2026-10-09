import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agyEnterprise from "../../open-sse/services/agyEnterprise.ts";

const dataDir = mkdtempSync(join(tmpdir(), "enterprise-models-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const { createProviderConnection, getProviderConnectionById } =
  await import("../../src/lib/db/providers.ts");
const { addCustomModel, setModelIsHidden } = await import("../../src/lib/db/models.ts");
const { getCachedDiscoveredModels } =
  await import("../../src/lib/providerModels/modelDiscovery.ts");
const { GET } = await import("../../src/app/api/providers/[id]/models/route.ts");
const { getAgyEnterpriseUsage } = await import("../../open-sse/services/usage/agyEnterprise.ts");
test.after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

const summary = {
  groups: [
    {
      buckets: [
        {
          bucketId: "gemini-3.8-flash-high",
          displayName: "Gemini Flash High",
          remainingFraction: 0,
        },
        { bucketId: "custom-experience" },
        { bucketId: "custom-experience", displayName: "Duplicate" },
        { bucketId: "empty-name", displayName: " " },
      ],
    },
    { buckets: [{ bucketId: "weekly-window", remainingFraction: 1 }] },
  ],
};
let sequence = 0;
async function connection(autoFetchModels = true) {
  return createProviderConnection({
    provider: "agy-enterprise",
    authType: "oauth",
    accessToken: "synthetic",
    email: `person-${++sequence}@example.com`,
    projectId: "project-one",
    isActive: true,
    testStatus: "unavailable",
    lastError: "inference denied",
    errorCode: 403,
    providerSpecificData: {
      projectId: "project-one",
      location: "eu",
      userTier: "standard",
      autoFetchModels,
    },
  });
}
const call = (id: string, query = "refresh=true") =>
  GET(new Request(`http://localhost/api/providers/${id}/models?${query}`), { params: { id } });

test("model discovery reads first-group buckets including exhausted IDs and preserves names", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(
      String(url),
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
    );
    assert.equal(init?.method, "POST");
    assert.equal(init?.body, "{}");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic");
    return Response.json(summary);
  });
  assert.equal(typeof agyEnterprise.fetchAgyEnterpriseModels, "function");
  assert.deepEqual(await agyEnterprise.fetchAgyEnterpriseModels("synthetic"), [
    {
      id: "gemini-3.8-flash-high",
      name: "Gemini Flash High",
      apiFormat: "gemini",
      supportsTools: false,
    },
    {
      id: "custom-experience",
      name: "custom-experience",
      apiFormat: "gemini",
      supportsTools: false,
    },
    { id: "empty-name", name: "empty-name", apiFormat: "gemini", supportsTools: false },
  ]);
});

test("model refresh persists, caches, replaces and clears only valid empty results", async (t) => {
  const c = await connection();
  const initial = await getProviderConnectionById(c.id);
  let payload: unknown = summary;
  let status = 200;
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(payload, { status });
  });
  const first = await (await call(c.id)).json();
  assert.equal(first.source, "api");
  assert.equal(first.models.length, 3);
  assert.equal((await getCachedDiscoveredModels("agy-enterprise", c.id)).length, 3);
  assert.equal((await (await call(c.id, "refresh=false")).json()).source, "cache");
  assert.equal(calls, 1);
  payload = { groups: [{ buckets: [{ bucketId: "replacement-model" }] }] };
  await call(c.id);
  assert.deepEqual(
    (await getCachedDiscoveredModels("agy-enterprise", c.id)).map((m) => m.id),
    ["replacement-model"]
  );
  for (const bad of [{}, { groups: null }, { groups: [{ buckets: [{ bucketId: " " }] }] }]) {
    payload = bad;
    assert.equal((await (await call(c.id)).json()).source, "cache");
    assert.equal(
      (await getCachedDiscoveredModels("agy-enterprise", c.id))[0].id,
      "replacement-model"
    );
  }
  status = 403;
  payload = { error: "private upstream content at /private/secret" };
  const failure = await (await call(c.id)).json();
  assert.equal(failure.source, "cache");
  assert.equal(JSON.stringify(failure).includes("/private/secret"), false);
  status = 200;
  payload = { groups: [{ buckets: [] }] };
  const empty = await (await call(c.id)).json();
  assert.deepEqual(await getCachedDiscoveredModels("agy-enterprise", c.id), []);
  assert.equal(
    empty.models.some((m: { id: string }) => m.id === "replacement-model"),
    false
  );
  const row = await getProviderConnectionById(c.id);
  assert.equal(row.testStatus, "unavailable");
  assert.equal(row.lastError, "inference denied");
  assert.equal(row.errorCode, initial.errorCode);
});

test("disabled automatic discovery makes no request; explicit refresh merges custom metadata and hidden filtering", async (t) => {
  const c = await connection(false);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return Response.json(summary);
  });
  assert.equal((await (await call(c.id, "refresh=false")).json()).source, "local_catalog");
  assert.equal(calls, 0);
  await addCustomModel("agy-enterprise", "custom-experience", "My custom label");
  setModelIsHidden("agy-enterprise", "empty-name", true);
  const result = await (await call(c.id, "refresh=true&excludeHidden=true")).json();
  assert.equal(calls, 1);
  assert.equal(
    result.models.find((m: { id: string }) => m.id === "custom-experience").name,
    "My custom label"
  );
  assert.equal(
    result.models.some((m: { id: string }) => m.id === "empty-name"),
    false
  );
  const withoutCustom = await (await call(c.id, "refresh=false&excludeCustom=true")).json();
  assert.equal(
    withoutCustom.models.find((m: { id: string }) => m.id === "custom-experience").name,
    "custom-experience"
  );
  const usage = await getAgyEnterpriseUsage("synthetic", c.providerSpecificData);
  assert.equal(usage.quotas, null);
  assert.equal(usage.quotaObservations?.authority, "advisory");
  assert.equal((await getProviderConnectionById(c.id)).testStatus, "unavailable");
});
