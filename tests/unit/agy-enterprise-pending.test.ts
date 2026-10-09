import test from "node:test";
import assert from "node:assert/strict";
import {
  AgyEnterprisePendingSetup,
  type AgyEnterpriseTokens,
} from "../../src/lib/oauth/agyEnterprisePendingSetup.ts";

const tokens = (): AgyEnterpriseTokens => ({
  accessToken: "synthetic",
  expiresAt: "2026-10-02T11:00:00Z",
  providerSpecificData: { googleSubject: "synthetic-subject" },
});
const license = { projectId: "project-one", location: "us", userTier: "standard" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("pending setup is owner-bound, absolutely expires and clears credentials", () => {
  let now = 1000;
  const store = new AgyEnterprisePendingSetup(() => now);
  const setup = store.create("owner", tokens());
  const ticket = store.pending(setup.setupId, "owner");
  assert.throws(() => store.get(setup.setupId, "other"));
  now = setup.expiresAt;
  assert.throws(() => store.get(setup.setupId, "owner"), /expired/);
  assert.equal(ticket.tokens, undefined);
  assert.equal(ticket.controller.signal.aborted, true);
});

test("finalize coalesces duplicates, rejects a different selection and retains completed result", async () => {
  const store = new AgyEnterprisePendingSetup();
  const setup = store.create("owner", tokens());
  const entries = store.addLicenses(
    setup.setupId,
    "owner",
    [license, { ...license, projectId: "project-two" }],
    "discovered"
  );
  const gate = deferred();
  let commits = 0;
  const validate = () => gate.promise;
  const commit = () => {
    commits++;
    return "saved-id";
  };
  const attempt = store.finalize(setup.setupId, "owner", entries[0].licenseId, validate, commit);
  assert.equal(
    store.finalize(setup.setupId, "owner", entries[0].licenseId, validate, commit),
    attempt
  );
  assert.throws(
    () => store.finalize(setup.setupId, "owner", entries[1].licenseId, validate, commit),
    /frozen/
  );
  gate.resolve();
  const result = await attempt;
  assert.equal(commits, 1);
  assert.equal(store.get(setup.setupId, "owner").tokens, undefined);
  assert.deepEqual(
    await store.finalize(setup.setupId, "owner", entries[0].licenseId, validate, commit),
    result
  );
  assert.deepEqual(store.cancel(setup.setupId, "owner"), result);
});

test("cancel and expiry during config validation prevent a late commit", async () => {
  for (const cancel of [true, false]) {
    let now = 0;
    const store = new AgyEnterprisePendingSetup(() => now);
    const setup = store.create("owner", tokens());
    const ticket = store.get(setup.setupId, "owner");
    const [entry] = store.addLicenses(setup.setupId, "owner", [license], "discovered");
    const gate = deferred();
    let commits = 0;
    const attempt = store.finalize(
      setup.setupId,
      "owner",
      entry.licenseId,
      () => gate.promise,
      () => {
        commits++;
        return "late";
      }
    );
    await Promise.resolve();
    if (cancel) store.cancel(setup.setupId, "owner");
    else now = setup.expiresAt;
    gate.resolve();
    await assert.rejects(attempt);
    assert.equal(commits, 0);
    assert.equal(ticket.tokens, undefined);
  }
});

test("validation errors preserve pending tokens and allow a retry, unsupported locations remain visible", async () => {
  const store = new AgyEnterprisePendingSetup();
  const setup = store.create("owner", tokens());
  const entries = store.addLicenses(
    setup.setupId,
    "owner",
    [license, { ...license, location: "global" }],
    "discovered"
  );
  assert.equal(entries[1].supported, false);
  assert.throws(() =>
    store.finalize(
      setup.setupId,
      "owner",
      entries[1].licenseId,
      async () => {},
      () => "bad"
    )
  );
  await assert.rejects(
    store.finalize(
      setup.setupId,
      "owner",
      entries[0].licenseId,
      async () => {
        throw new Error("config denied");
      },
      () => "bad"
    )
  );
  assert.equal(store.pending(setup.setupId, "owner").tokens.accessToken, "synthetic");
  assert.equal(
    (
      await store.finalize(
        setup.setupId,
        "owner",
        entries[0].licenseId,
        async () => {},
        () => "saved"
      )
    ).connectionId,
    "saved"
  );
});

test("EU licenses are supported and finalizable", async () => {
  const store = new AgyEnterprisePendingSetup();
  const setup = store.create("owner", tokens());
  const [entry] = store.addLicenses(
    setup.setupId,
    "owner",
    [{ ...license, location: "eu" }],
    "discovered"
  );
  assert.equal(entry.supported, true);
  const result = await store.finalize(
    setup.setupId,
    "owner",
    entry.licenseId,
    async (_ticket, selected) => {
      assert.equal(selected.location, "eu");
    },
    () => "eu-connection"
  );
  assert.equal(result.connectionId, "eu-connection");
});

test("Enterprise setup persists trusted license source in the latest stable selection", async () => {
  const store = new AgyEnterprisePendingSetup();
  const setup = store.create("owner", tokens());
  const [discovered] = store.addLicenses(setup.setupId, "owner", [license], "discovered");
  assert.equal(discovered.licenseSource, "discovered");
  const [custom] = store.addLicenses(
    setup.setupId,
    "owner",
    [{ ...license, userTier: "custom-tier", ...{ licenseSource: "discovered" } }],
    "custom"
  );
  assert.equal(custom.licenseId, discovered.licenseId);
  assert.equal(custom.licenseSource, "custom");
  const [rediscovered] = store.addLicenses(
    setup.setupId,
    "owner",
    [{ ...license, userTier: "latest-tier", ...{ licenseSource: "custom" } }],
    "discovered"
  );
  assert.equal(rediscovered.licenseId, discovered.licenseId);
  assert.equal(rediscovered.licenseSource, "discovered");
  await store.finalize(
    setup.setupId,
    "owner",
    discovered.licenseId,
    async (_ticket, selected) => {
      assert.equal(selected.licenseSource, "discovered");
      assert.equal(selected.userTier, "latest-tier");
    },
    (_ticket, selected) => {
      assert.equal(selected.licenseSource, "discovered");
      return "saved-latest";
    }
  );
});
