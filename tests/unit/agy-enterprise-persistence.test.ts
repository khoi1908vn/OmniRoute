import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "omniroute-enterprise-"));
process.env.DATA_DIR = dataDir;
process.env.APP_LOG_TO_FILE = "false";
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
  assert.equal((await db.getProviderConnectionById(existing.id))?.projectId, "reauth-project");
});
