import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as store from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";
import { shouldSkipConnDisable } from "../../open-sse/services/combo/comboPredicates.ts";

const model = "gemini-3.8-flash-high";
const namespace = store.buildAgyEnterpriseReplayNamespace("diagnostics", model);
const history = [{ role: "user", parts: [{ text: "synthetic diagnostic" }] }];
const call = { id: "safe-call-id", name: "Edit", args: { value: "PRIVATE_SYNTHETIC_VALUE" } };
const part = { functionCall: call, thoughtSignature: "PRIVATE_SYNTHETIC_SIGNATURE" };
const state = () => ({
  provider: "agy-enterprise",
  signatureNamespace: namespace,
  enterpriseReplayHistory: history,
});
const resolve = (incoming = call, group = [incoming], prefix: unknown = history) =>
  store.resolveAgyEnterpriseCallReplay(namespace, incoming, group, prefix);
function reason(expected: string, incoming = call, group = [incoming], prefix: unknown = history) {
  const result = resolve(incoming, group, prefix);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("Expected replay rejection");
  assert.equal(result.reason, expected);
  return result;
}
function rewriteRow(transform: (row: Record<string, unknown>) => Record<string, unknown>) {
  const db = getDbInstance();
  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all("gemini_thought_signatures") as Array<{ key: string; value: string }>;
  for (const row of rows)
    db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
      JSON.stringify(transform(JSON.parse(row.value))),
      "gemini_thought_signatures",
      row.key
    );
}
test.beforeEach(() => store.clearGeminiThoughtSignatures());
test.after(() => resetDbInstance());

test("call failures distinguish missing, arguments, groups, legacy and invalid records", () => {
  assert.equal(reason("missing").originRecords, 0);
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  const incoming = { ...call, args: { value: "CHANGED_PRIVATE_VALUE" } };
  const failure = reason("argument_mismatch", incoming);
  assert.equal(failure.originRecords, 1);
  const diagnostic = store.describeAgyEnterpriseReplayFailure(
    namespace,
    "call",
    call.id,
    history,
    failure
  );
  assert.match(diagnostic, /reason=argument_mismatch/);
  assert.match(diagnostic, /difference=changed/);
  assert.match(diagnostic, /originRecords=1/);
  assert.ok(!diagnostic.includes("PRIVATE"));
  reason("group_mismatch", call, [{ ...call, id: "missing-sibling" }]);
  rewriteRow((row) => ({ ...row, signature: "not-a-record" }));
  reason("invalid_record");
  store.clearGeminiThoughtSignatures();
  store.storeAgyEnterpriseCallSignature(namespace, call, part.thoughtSignature, history);
  reason("legacy_schema_unavailable", incoming);
});

test("expired, conflicting, ambiguous and unavailable stores never rebind", (t) => {
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  rewriteRow((row) => ({ ...row, expiresAt: 1 }));
  reason("expired");
  store.clearGeminiThoughtSignatures();
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  store.captureAgyEnterpriseReplayParts(
    state(),
    [{ ...part, thoughtSignature: "different" }],
    true
  );
  reason("conflicting_capture");
  store.clearGeminiThoughtSignatures();
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  store.captureAgyEnterpriseReplayParts({ ...state(), enterpriseReplayHistory: [] }, [part], true);
  assert.equal(
    reason("ambiguous_origin", call, [call], [{ role: "user", parts: [{ text: "rebuilt" }] }])
      .originRecords,
    2
  );
  const prepare = t.mock.method(getDbInstance(), "prepare", () => {
    throw new Error("PRIVATE_DB_ERROR");
  });
  const failure = reason("store_unavailable");
  const diagnostic = store.describeAgyEnterpriseReplayFailure(
    namespace,
    "call",
    call.id,
    history,
    failure
  );
  assert.match(diagnostic, /reason=store_unavailable/);
  assert.ok(!diagnostic.includes("PRIVATE"));
  prepare.mock.restore();
});

test("translator errors classify the resolved failure and protect completed actions", () => {
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  assert.throws(
    () =>
      claudeToGeminiRequest(
        model,
        {
          messages: [
            { role: "user", content: "synthetic diagnostic" },
            {
              role: "assistant",
              content: [
                { type: "tool_use", id: call.id, name: call.name, input: { value: "changed" } },
              ],
            },
            {
              role: "user",
              content: [
                { type: "tool_result", tool_use_id: call.id, content: "already succeeded" },
              ],
            },
          ],
        },
        false,
        { _provider: "agy-enterprise", _signatureNamespace: "diagnostics" }
      ),
    (error: unknown) => {
      const err = error as Error & { statusCode: number };
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /reason=argument_mismatch/);
      assert.match(err.message, /completed.*actions/i);
      assert.ok(!err.message.includes("PRIVATE"));
      assert.ok(!err.message.includes("at /"));
      return true;
    }
  );
});

async function rejectInHandler(noLog = false) {
  const body = {
    model: `agy-enterprise/${model}`,
    stream: false,
    max_tokens: 2048,
    messages: [
      { role: "user", content: "synthetic diagnostic" },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "uncaptured-call", name: "Edit", input: { value: "PRIVATE" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "uncaptured-call", content: "already succeeded" },
        ],
      },
    ],
  };
  return handleChatCore({
    body,
    modelInfo: { provider: "agy-enterprise", model },
    credentials: {
      accessToken: "synthetic",
      providerSpecificData: { projectId: "synthetic", location: "us", userTier: "standard" },
    },
    connectionId: "diagnostics",
    correlationId: `replay-diagnostic-${noLog}`,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    clientRawRequest: {
      endpoint: "/v1/messages",
      body: structuredClone(body),
      headers: new Headers({
        "x-correlation-id": `replay-diagnostic-${noLog}`,
        "x-omniroute-session-id": `synthetic-session-${noLog}`,
      }),
    },
    apiKeyInfo: noLog ? { noLog: true } : null,
    userAgent: null,
    comboName: null,
    onCredentialsRefreshed: undefined,
    onRequestSuccess: undefined,
    onStreamFailure: undefined,
    onDisconnect: undefined,
  });
}

test("early replay rejection is logged once with correlation and never dispatched", async (t) => {
  let sent = 0;
  t.mock.method(globalThis, "fetch", async () => {
    sent++;
    throw new Error("Unexpected dispatch");
  });
  const result = await rejectInHandler();
  assert.ok(!(result instanceof Response));
  assert.equal(result.status, 400);
  assert.equal(result.errorCode, "request_translation_failed");
  assert.equal(shouldSkipConnDisable(result, false, false, "agy-enterprise"), true);
  assert.equal(sent, 0);
  const pending = (
    globalThis as unknown as {
      __omnirouteUsageHistoryPendingState: {
        pendingRequests: { byAccount: Record<string, Record<string, number>> };
      };
    }
  ).__omnirouteUsageHistoryPendingState.pendingRequests.byAccount.diagnostics;
  assert.ok(!pending || Object.values(pending).every((count) => count === 0));
  // Persistence uses the existing best-effort async sink.
  const db = getDbInstance();
  let rows: Array<Record<string, unknown>> = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    rows = db
      .prepare("SELECT * FROM call_logs WHERE session_tag = ?")
      .all("synthetic-session-false") as Array<Record<string, unknown>>;
    if (rows.length) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 400);
  assert.equal(rows[0].provider, "agy-enterprise");
  assert.equal(rows[0].connection_id, "diagnostics");
  assert.equal(rows[0].correlation_id, "replay-diagnostic-false");
  assert.match(String(rows[0].error_summary), /reason=missing/);
  assert.ok(!String(rows[0].error_summary).includes("PRIVATE"));
  assert.equal((await result.response.json()).error.type, "invalid_request_error");
});

test("early rejection honors no-log policy", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected dispatch");
  });
  const result = await rejectInHandler(true);
  assert.ok(!(result instanceof Response));
  assert.equal(result.status, 400);
  await new Promise((done) => setTimeout(done, 20));
  const rows = getDbInstance()
    .prepare("SELECT * FROM call_logs WHERE session_tag = ?")
    .all("synthetic-session-true") as Array<Record<string, unknown>>;
  // Existing no-log policy retains metadata, while omitting payload artifacts.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].has_request_body, 0);
  assert.equal(rows[0].has_response_body, 0);
  assert.equal(rows[0].has_pipeline_details, 0);
  assert.equal(rows[0].artifact_relpath, null);
  assert.equal(rows[0].request_summary, null);
});

test("a failed log sink preserves the intended local HTTP 400", async (t) => {
  const db = getDbInstance();
  const prepare = db.prepare;
  t.mock.method(db, "prepare", function (sql: string) {
    if (sql.includes("INSERT INTO call_logs")) throw new Error("synthetic unavailable sink");
    return prepare.call(db, sql);
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Unexpected dispatch");
  });
  const result = await rejectInHandler();
  assert.ok(!(result instanceof Response));
  assert.equal(result.status, 400);
  assert.match((await result.response.json()).error.message, /reason=missing/);
  await new Promise((done) => setTimeout(done, 50));
});
