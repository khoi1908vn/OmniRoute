import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agyEnterpriseContextSchema,
  agyEnterpriseIdentitySnapshot,
} from "../../open-sse/utils/agyEnterprise.ts";

const dataDir = mkdtempSync(join(tmpdir(), "omniroute-enterprise-"));
process.env.DATA_DIR = dataDir;
process.env.APP_LOG_TO_FILE = "false";
process.env.STORAGE_ENCRYPTION_KEY = "synthetic-enterprise-persistence-key";
const core = await import("../../src/lib/db/core.ts");
const db = await import("../../src/lib/db/providers.ts");
const { persistOAuthConnection, findExistingOAuthConnectionMatch } =
  await import("../../src/lib/oauth/connectionPersistence.ts");

function credentials(
  projectId = "project-one",
  googleSubject: string | undefined = "subject-one",
  location = "us",
  email = "person@example.com"
) {
  return {
    email,
    accessToken: "synthetic-access",
    refreshToken: "synthetic-refresh",
    expiresIn: 3600,
    expiresAt: "2026-10-02T10:00:00.000Z",
    projectId,
    providerSpecificData: { projectId, location, userTier: "standard-tier", googleSubject },
  };
}

test.after(() => {
  core.resetDbInstance();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Enterprise OAuth matching separates contexts and distinct known subjects", () => {
  const row = { id: "existing", provider: "agy-enterprise", authType: "oauth", ...credentials() };
  assert.equal(
    findExistingOAuthConnectionMatch([row], "agy-enterprise", credentials("project-two")),
    undefined
  );
  assert.equal(
    findExistingOAuthConnectionMatch(
      [row],
      "agy-enterprise",
      credentials("project-one", "subject-two")
    ),
    undefined
  );
  assert.equal(
    findExistingOAuthConnectionMatch(
      [row],
      "agy-enterprise",
      credentials("project-one", "subject-one", "eu")
    ),
    undefined
  );
  assert.equal(
    findExistingOAuthConnectionMatch(
      [row],
      "agy-enterprise",
      credentials("project-one", "subject-one", "us", "changed@example.com")
    )?.id,
    "existing"
  );
  assert.equal(
    findExistingOAuthConnectionMatch(
      [{ ...row, providerSpecificData: { ...row.providerSpecificData, googleSubject: undefined } }],
      "agy-enterprise",
      {
        ...credentials("project-one", "subject-two", "us", " PERSON@EXAMPLE.COM "),
        providerSpecificData: { ...row.providerSpecificData, googleSubject: undefined },
      }
    )?.id,
    "existing"
  );
});

test("direct DB and OAuth persistence converge on account/project/location, retaining absolute expiry", async () => {
  const first = await persistOAuthConnection("agy-enterprise", credentials());
  const second = await db.createProviderConnection({
    provider: "agy-enterprise",
    authType: "oauth",
    ...credentials("project-two"),
  });
  const region = await db.createProviderConnection({
    provider: "agy-enterprise",
    authType: "oauth",
    ...credentials("project-one", "subject-one", "eu"),
  });
  const distinct = await db.createProviderConnection({
    provider: "agy-enterprise",
    authType: "oauth",
    ...credentials("project-one", "subject-two"),
  });
  assert.equal(new Set([first.id, second.id, region.id, distinct.id]).size, 4);
  const updated = await persistOAuthConnection("agy-enterprise", {
    ...credentials(),
    providerSpecificData: { ...credentials().providerSpecificData, userTier: "updated-tier" },
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.expiresAt, "2026-10-02T10:00:00.000Z");
  assert.equal(updated.tokenExpiresAt, "2026-10-02T10:00:00.000Z");
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      persistOAuthConnection("agy-enterprise", credentials("project-concurrent"))
    )
  );
  assert.equal(new Set(concurrent.map((row) => row.id)).size, 1);
  assert.equal((await db.getProviderConnections({ provider: "agy-enterprise" })).length, 5);
});

test("Enterprise reauth rejects mismatched and deleted targets without retargeting or recreating", async () => {
  const existing = await persistOAuthConnection("agy-enterprise", credentials("reauth-project"));
  const storedBefore = await db.getProviderConnectionById(existing.id);
  const countBefore = (await db.getProviderConnections({ provider: "agy-enterprise" })).length;
  await assert.rejects(
    persistOAuthConnection(
      "agy-enterprise",
      credentials("reauth-project", "subject-one", "eu"),
      existing.id
    )
  );
  await assert.rejects(
    persistOAuthConnection("agy-enterprise", credentials("different-project"), existing.id)
  );
  await assert.rejects(
    persistOAuthConnection(
      "agy-enterprise",
      credentials("reauth-project", "another-subject"),
      existing.id
    )
  );
  await assert.rejects(
    persistOAuthConnection("agy-enterprise", credentials("reauth-project"), "deleted-target")
  );
  assert.deepEqual(await db.getProviderConnectionById(existing.id), storedBefore);
  assert.equal(
    (await db.getProviderConnections({ provider: "agy-enterprise" })).length,
    countBefore
  );
});

test("Enterprise reauthorization and dedup preserve operator controls", async (t) => {
  for (const mode of ["explicit-target", "dedup", "settings-after-snapshot"] as const) {
    await t.test(mode, async () => {
      const tokens = credentials(`controls-${mode}`);
      const original = await persistOAuthConnection("agy-enterprise", {
        ...tokens,
        providerSpecificData: {
          ...tokens.providerSpecificData,
          autoFetchModels: mode !== "settings-after-snapshot",
          autoSync: mode !== "settings-after-snapshot",
          disableCooling: mode !== "settings-after-snapshot",
          requestDefaults: { temperature: 0.25 },
          oauthClient: "old-issuer",
          verifiedAt: "2026-10-01T10:00:00.000Z",
          licenseSource: "discovered",
        },
      });
      const identity = agyEnterpriseIdentitySnapshot(original);
      if (mode === "settings-after-snapshot") {
        await db.updateProviderConnection(original.id, {
          providerSpecificData: {
            ...original.providerSpecificData,
            autoFetchModels: true,
            autoSync: true,
            disableCooling: true,
            requestDefaults: { temperature: 0.75 },
          },
        });
      }
      const storedBefore = core
        .getDbInstance()
        .prepare("SELECT refresh_token FROM provider_connections WHERE id = ?")
        .get(original.id) as { refresh_token: string };
      const { refreshToken: _omitted, ...incomingTokens } = tokens;
      const incoming = {
        ...incomingTokens,
        accessToken: "synthetic-new-access",
        providerSpecificData: {
          ...tokens.providerSpecificData,
          userTier: "updated-tier",
          oauthClient: "new-issuer",
          verifiedAt: "2026-10-03T10:00:00.000Z",
          licenseSource: "custom",
        },
      };
      const updated =
        mode === "dedup"
          ? await db.createProviderConnection({
              provider: "agy-enterprise",
              authType: "oauth",
              ...incoming,
            })
          : await persistOAuthConnection("agy-enterprise", incoming, original.id, identity);
      assert.equal(updated.id, original.id);
      for (const row of [updated, await db.getProviderConnectionById(original.id)]) {
        const metadata = row.providerSpecificData as Record<string, unknown>;
        assert.equal(metadata.autoFetchModels, true);
        assert.equal(metadata.autoSync, true);
        assert.equal(metadata.disableCooling, true);
        assert.deepEqual(metadata.requestDefaults, {
          temperature: mode === "settings-after-snapshot" ? 0.75 : 0.25,
        });
        assert.equal(metadata.userTier, "updated-tier");
        assert.equal(metadata.oauthClient, "new-issuer");
        assert.equal(metadata.verifiedAt, "2026-10-03T10:00:00.000Z");
        assert.equal(metadata.licenseSource, "custom");
        assert.equal(row.accessToken, "synthetic-new-access");
        assert.equal(row.refreshToken, "synthetic-refresh");
      }
      const storedAfter = core
        .getDbInstance()
        .prepare("SELECT refresh_token FROM provider_connections WHERE id = ?")
        .get(original.id) as { refresh_token: string };
      assert.match(storedAfter.refresh_token, /^enc:v1:/);
      assert.equal(storedAfter.refresh_token, storedBefore.refresh_token);
    });
  }
});

test("legacy Enterprise rows remain readable without fabricated license provenance", async () => {
  const tokens = credentials("legacy-provenance");
  const original = await persistOAuthConnection("agy-enterprise", tokens);
  const legacy = await db.getProviderConnectionById(original.id);
  assert.equal(
    agyEnterpriseContextSchema.parse(legacy.providerSpecificData).projectId,
    "legacy-provenance"
  );
  assert.equal(Object.hasOwn(legacy.providerSpecificData, "licenseSource"), false);
  assert.equal(Object.hasOwn(legacy.providerSpecificData, "verifiedAt"), false);
  const updated = await persistOAuthConnection(
    "agy-enterprise",
    {
      ...tokens,
      accessToken: "synthetic-legacy-refresh",
    },
    original.id
  );
  assert.equal(updated.id, original.id);
  const stored = await db.getProviderConnectionById(original.id);
  assert.equal(Object.hasOwn(stored.providerSpecificData, "licenseSource"), false);
  assert.equal(Object.hasOwn(stored.providerSpecificData, "verifiedAt"), false);
});

test("Enterprise reauthorization preserves omitted refresh tokens and honors explicit replacements", async (t) => {
  for (const mode of ["absent", "undefined", "null", "replacement"] as const) {
    await t.test(mode, async () => {
      const tokens = credentials(`refresh-${mode}`);
      const original = await persistOAuthConnection("agy-enterprise", tokens);
      const storedBefore = core
        .getDbInstance()
        .prepare("SELECT refresh_token FROM provider_connections WHERE id = ?")
        .get(original.id) as { refresh_token: string };
      const { refreshToken: _omitted, ...incoming } = tokens;
      const payload = {
        ...incoming,
        ...(mode === "absent"
          ? {}
          : {
              refreshToken:
                mode === "undefined" ? undefined : mode === "null" ? null : "synthetic-replacement",
            }),
      };
      const updated = await persistOAuthConnection("agy-enterprise", payload, original.id);
      const expected =
        mode === "null"
          ? undefined
          : mode === "replacement"
            ? "synthetic-replacement"
            : "synthetic-refresh";
      assert.equal(updated.refreshToken, expected);
      assert.equal((await db.getProviderConnectionById(original.id)).refreshToken, expected);
      const storedAfter = core
        .getDbInstance()
        .prepare("SELECT refresh_token FROM provider_connections WHERE id = ?")
        .get(original.id) as { refresh_token: string | null };
      if (mode === "absent" || mode === "undefined") {
        assert.equal(storedAfter.refresh_token, storedBefore.refresh_token);
        assert.match(storedAfter.refresh_token, /^enc:v1:/);
      } else if (mode === "null") {
        assert.equal(storedAfter.refresh_token, null);
      } else {
        assert.match(storedAfter.refresh_token!, /^enc:v1:/);
        assert.notEqual(storedAfter.refresh_token, storedBefore.refresh_token);
      }
    });
  }
});
