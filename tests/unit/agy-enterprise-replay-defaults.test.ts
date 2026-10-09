import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as store from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { parseSSEToGeminiResponse } from "../../open-sse/handlers/sseParser/geminiResponse.ts";
import { parseNonStreamingResponseBody } from "../../open-sse/handlers/chatCore/nonStreamingResponseParse.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import * as schemaHelpers from "../../open-sse/translator/response/openai-responses/toolSchemas.ts";
import { runNonStreamingProviderLeg } from "../../open-sse/handlers/chatCore/nonStreamingProviderLeg.ts";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";

const model = "gemini-3.8-flash-high";
const namespace = store.buildAgyEnterpriseReplayNamespace("default-tests", model);
const history = [{ role: "user", parts: [{ text: "synthetic task" }] }];
const args = { file_path: "synthetic.txt", old_string: "before", new_string: "after" };
const call = { id: "edit-default", name: "Edit", args };
const part = { functionCall: call, thoughtSignature: "synthetic-signature" };
const schema = () => ({
  type: "object",
  properties: {
    file_path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
    replace_all: { type: "boolean", default: false },
  },
  required: ["file_path", "old_string", "new_string"],
});
const state = (declaration: Record<string, unknown> = schema()) => ({
  provider: "agy-enterprise",
  signatureNamespace: namespace,
  enterpriseReplayHistory: history,
  enterpriseReplaySchemas: new Map([["Edit", declaration]]),
});
const replay = (input: unknown, calls = [{ ...call, args: input }]) =>
  store.getAgyEnterpriseCallReplay(namespace, { ...call, args: input }, calls, history);
test.beforeEach(() => store.clearGeminiThoughtSignatures());
test.after(() => resetDbInstance());

test("optional default insertion returns the original native part without mutation", () => {
  const original = structuredClone(part);
  const input = { ...args, replace_all: false };
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  const result = replay(input);
  assert.ok(result);
  assert.deepEqual(result.nativePart, original);
  assert.equal(result.match, "optional_default_inserted");
  assert.deepEqual(part, original);
  assert.deepEqual(input, { ...args, replace_all: false });
  result.nativePart.functionCall.args = {};
  assert.deepEqual(replay(input)?.nativePart, original);
});

test("explicit native default is preserved and exact calls need no schema", () => {
  const explicit = {
    functionCall: { ...call, args: { ...args, replace_all: false } },
    thoughtSignature: part.thoughtSignature,
  };
  store.captureAgyEnterpriseReplayParts(state({}), [explicit], true);
  assert.deepEqual(replay(explicit.functionCall.args)?.nativePart, explicit);
  assert.equal(replay(args), null);
});

test("default matching rejects changed, removed, unexpected and mistyped arguments", () => {
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  for (const input of [
    { ...args, replace_all: true },
    { ...args, replace_all: null },
    { ...args, replace_all: "false" },
    { ...args, old_string: "changed" },
    { ...args, unexpected: false },
    { file_path: args.file_path, new_string: args.new_string },
  ])
    assert.equal(replay(input), null);
});

test("required, undeclared, nested and conditional defaults do not authorize insertion", () => {
  for (const declaration of [
    { ...schema(), required: [...schema().required, "replace_all"] },
    { ...schema(), properties: { replace_all: { type: "boolean" } } },
    { ...schema(), properties: { replace_all: { type: "boolean", default: "false" } } },
    { ...schema(), allOf: [{}] },
    { ...schema(), if: { properties: { file_path: { const: "synthetic.txt" } } } },
    {
      ...schema(),
      properties: {
        options: {
          type: "object",
          default: {},
          properties: {
            replace_all: { type: "boolean", default: false },
          },
        },
      },
    },
  ]) {
    store.clearGeminiThoughtSignatures();
    store.captureAgyEnterpriseReplayParts(state(declaration), [part], true);
    assert.equal(replay({ ...args, replace_all: false }), null);
  }
});

test("constrained or malformed issuance schemas grant exact replay only", () => {
  const invalidDefaults: Array<Record<string, unknown>> = [
    { type: "boolean", default: false, enum: [true] },
    { type: "boolean", default: false, const: true },
    { type: "integer", default: 0, minimum: 1 },
    { type: "string", default: "", minLength: 1 },
    { type: "boolean", default: false, unknownConstraint: true },
  ];
  for (const property of invalidDefaults) {
    store.clearGeminiThoughtSignatures();
    store.captureAgyEnterpriseReplayParts(
      state({
        ...schema(),
        properties: {
          ...schema().properties,
          replace_all: property,
        },
      }),
      [part],
      true
    );
    assert.equal(replay({ ...args, replace_all: property.default }), null);
    assert.deepEqual(replay(args)?.nativePart, part);
  }
  for (const declaration of [
    { ...schema(), dependentRequired: { file_path: ["replace_all"] } },
    { ...schema(), required: "replace_all" },
    { ...schema(), required: [null] },
    { ...schema(), maxProperties: 3 },
    { ...schema(), unknownConstraint: true },
  ]) {
    store.clearGeminiThoughtSignatures();
    store.captureAgyEnterpriseReplayParts(state(declaration), [part], true);
    assert.equal(replay({ ...args, replace_all: false }), null);
    assert.deepEqual(replay(args)?.nativePart, part);
  }
});

test("multiple top-level defaults use immutable issuance metadata across DB reopen", () => {
  const declaration = {
    ...schema(),
    properties: {
      ...schema().properties,
      label: { type: "string", default: "" },
      retries: { type: "integer", default: 0 },
    },
  };
  const capture = state(declaration);
  store.captureAgyEnterpriseReplayParts(capture, [part], false);
  declaration.properties.replace_all.default = true;
  store.captureAgyEnterpriseReplayParts(capture, [], true);
  store.clearGeminiThoughtSignatureMemoryForTests();
  resetDbInstance();
  assert.deepEqual(
    replay({ ...args, replace_all: false, label: "", retries: 0 })?.nativePart,
    part
  );
  assert.equal(replay({ ...args, replace_all: true }), null);
});

test("original native parts, signatures and ordered unsigned groups survive normalization", () => {
  const sibling = { ...call, id: "second-edit", args: { ...args, file_path: "second.txt" } };
  const parts = [{ text: "Preparing edits." }, part, { functionCall: sibling }];
  store.captureAgyEnterpriseReplayParts(state(), parts, true);
  const calls = [{ ...call, args: { ...args, replace_all: false } }, sibling];
  const first = store.getAgyEnterpriseCallReplay(namespace, calls[0], calls, history);
  const second = store.getAgyEnterpriseCallReplay(namespace, sibling, calls, history);
  assert.deepEqual(first?.nativePart, part);
  assert.deepEqual(second?.nativePart, { functionCall: sibling });
  assert.deepEqual(
    store.getAgyEnterpriseTextReplay(namespace, "Preparing edits.", calls, history),
    {}
  );
  for (const altered of [[sibling, calls[0]], [calls[0]], [calls[0], { ...sibling, args: {} }]]) {
    assert.equal(store.getAgyEnterpriseCallReplay(namespace, calls[0], altered, history), null);
  }
});

test("terminal capture only, deterministic conflicts and immutable origins", () => {
  store.captureAgyEnterpriseReplayParts(state(), [part], false);
  assert.equal(replay(args), null);
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  const reordered = {
    ...part,
    functionCall: {
      ...call,
      args: {
        new_string: "after",
        old_string: "before",
        file_path: "synthetic.txt",
      },
    },
  };
  store.captureAgyEnterpriseReplayParts(state(), [reordered], true);
  assert.ok(replay({ ...args, replace_all: false }));
  store.captureAgyEnterpriseReplayParts(
    state(),
    [{ ...part, thoughtSignature: "different" }],
    true
  );
  assert.equal(replay(args), null);
});

test("legacy hashes remain exact-only and v2 retains rollback identity fields", () => {
  store.storeAgyEnterpriseCallSignature(namespace, call, part.thoughtSignature, history);
  assert.ok(replay(args));
  assert.equal(replay({ ...args, replace_all: false }), null);
  store.clearGeminiThoughtSignatures();
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  const row = getDbInstance()
    .prepare("SELECT value FROM key_value WHERE namespace = ?")
    .get("gemini_thought_signatures") as { value: string };
  const record = JSON.parse(JSON.parse(row.value).signature) as {
    identity: string;
    signature: string;
  };
  assert.equal(typeof record.identity, "string");
  assert.equal(record.signature, part.thoughtSignature);
});

test("connection/model scope and ambiguous fallback origins still reject", () => {
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  for (const ns of [
    store.buildAgyEnterpriseReplayNamespace("other", model),
    store.buildAgyEnterpriseReplayNamespace("default-tests", "gemini-3.8-flash-low"),
  ]) {
    assert.equal(store.getAgyEnterpriseCallReplay(ns, call, [call], history), null);
  }
  store.captureAgyEnterpriseReplayParts({ ...state(), enterpriseReplayHistory: [] }, [part], true);
  assert.equal(
    store.getAgyEnterpriseCallReplay(
      namespace,
      call,
      [call],
      [{ role: "user", parts: [{ text: "rebuilt" }] }]
    ),
    null
  );
});

const credentials = { _provider: "agy-enterprise", _signatureNamespace: "default-tests" };
function assertClientReplay(parts: Array<Record<string, unknown>>) {
  const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall as typeof call);
  const contents = parts.flatMap((p) =>
    p.text
      ? [{ type: "text", text: p.text }]
      : p.functionCall
        ? [
            {
              type: "tool_use",
              id: (p.functionCall as typeof call).id,
              name: (p.functionCall as typeof call).name,
              input: { ...(p.functionCall as typeof call).args, replace_all: false },
            },
          ]
        : []
  );
  const body = {
    tools: [
      {
        name: "Edit",
        input_schema: {
          ...schema(),
          properties: {
            ...schema().properties,
            replace_all: { type: "boolean", default: true },
          },
        },
      },
    ],
    messages: [
      { role: "user", content: "synthetic task" },
      { role: "assistant", content: contents },
      {
        role: "user",
        content: calls.map((c) => ({
          type: "tool_result",
          tool_use_id: c.id,
          content: "already succeeded",
        })),
      },
    ],
  };
  const before = structuredClone(body);
  const claude = claudeToGeminiRequest(model, body, false, credentials);
  assert.deepEqual(claude.contents[1].parts, parts);
  assert.deepEqual(body, before);
  const openai = openaiToGeminiRequest(
    model,
    {
      messages: [
        { role: "user", content: "synthetic task" },
        {
          role: "assistant",
          content: parts
            .filter((p) => p.text)
            .map((p) => p.text)
            .join(""),
          tool_calls: calls.map((c) => ({
            type: "function",
            id: c.id,
            function: {
              name: c.name,
              arguments: JSON.stringify({ ...c.args, replace_all: false }),
            },
          })),
        },
        ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: "already succeeded" })),
      ],
    },
    false,
    credentials
  );
  assert.deepEqual(openai.contents[1].parts, parts);
  assert.ok(JSON.stringify(openai.contents[2]).includes("already succeeded"));
  assert.ok(JSON.stringify(claude.contents[2]).includes("already succeeded"));
}

test("both request translators replay original arguments despite current schema change", () => {
  const sibling = { functionCall: { ...call, id: "sibling" } };
  const parts = [{ text: "Preparing edits." }, part, sibling];
  store.captureAgyEnterpriseReplayParts(state(), parts, true);
  assertClientReplay(parts);
});

test("buffered SSE and native JSON carry issuance schemas into replay capture", async () => {
  const parts = [part];
  const payload = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }] };
  const context = {
    provider: "agy-enterprise",
    connectionId: "default-tests",
    experience: model,
    history,
    schemas: state().enterpriseReplaySchemas,
  };
  assert.ok(parseSSEToGeminiResponse(`data: ${JSON.stringify(payload)}\n\n`, model, context));
  assertClientReplay(parts);
  store.clearGeminiThoughtSignatures();
  const parsed = await parseNonStreamingResponseBody({
    providerResponse: Response.json(payload),
    upstreamStream: false,
    providerHeaders: new Headers(),
    finalBody: { contents: history },
    targetFormat: "gemini",
    model,
    geminiReplayContext: context,
  });
  assert.equal(parsed.kind, "ok");
  assertClientReplay(parts);
});

test("streaming Claude and OpenAI capture issuance schemas, incomplete streams do not", async () => {
  for (const client of ["claude", "openai"]) {
    store.clearGeminiThoughtSignatures();
    const payload = { candidates: [{ content: { parts: [part] }, finishReason: "STOP" }] };
    const transform = createSSEStream({
      targetFormat: "gemini",
      sourceFormat: client,
      provider: "agy-enterprise",
      model,
      connectionId: "default-tests",
      body: { contents: history },
      enterpriseReplaySchemas: state().enterpriseReplaySchemas,
    });
    const input = new Response(`data: ${JSON.stringify(payload)}\n\n`).body!;
    await new Response(input.pipeThrough(transform)).text();
    assertClientReplay([part]);
  }
  store.clearGeminiThoughtSignatures();
  const payload = { candidates: [{ content: { parts: [part] } }] };
  const transform = createSSEStream({
    targetFormat: "gemini",
    sourceFormat: "claude",
    provider: "agy-enterprise",
    model,
    connectionId: "default-tests",
    body: { contents: history },
    enterpriseReplaySchemas: state().enterpriseReplaySchemas,
  });
  await new Response(
    new Response(`data: ${JSON.stringify(payload)}\n\n`).body!.pipeThrough(transform)
  ).text();
  assert.equal(replay(args), null);
});

test("schema snapshots bind native aliases and exclude duplicate declarations", () => {
  const raw = { tools: [{ name: "mcp:Edit", input_schema: schema() }] };
  const aliases = new Map([["mcp_Edit", "mcp:Edit"]]);
  const schemas = schemaHelpers.extractEnterpriseReplaySchemas(raw, aliases);
  assert.ok(schemas?.has("mcp_Edit"));
  raw.tools[0].input_schema.properties.replace_all.default = true;
  const aliased = { ...part, functionCall: { ...call, name: "mcp_Edit" } };
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplaySchemas: schemas },
    [aliased],
    true
  );
  assert.ok(
    store.getAgyEnterpriseCallReplay(
      namespace,
      { ...aliased.functionCall, args: { ...args, replace_all: false } },
      [{ ...aliased.functionCall, args: { ...args, replace_all: false } }],
      history
    )
  );
  const duplicate = schemaHelpers.extractEnterpriseReplaySchemas({
    tools: [
      { name: "Edit", input_schema: schema() },
      { name: "Edit", input_schema: { ...schema(), properties: {} } },
    ],
  });
  assert.ok(!duplicate?.has("Edit"));
});

test("buffered provider leg snapshots the original client schema before dispatch", async () => {
  const sourceBody = { tools: [{ name: "Edit", input_schema: schema() }] };
  const result = await runNonStreamingProviderLeg({
    phase: "initial",
    sourceBody,
    allowAccountRotation: false,
    allowModelFallback: false,
    provider: "agy-enterprise",
    model,
    connectionId: "default-tests",
    sourceFormat: "claude",
    targetFormat: "gemini",
    clientResponseFormat: "claude",
    translatedBody: { contents: history },
    setRequestWireState() {},
    async executeProviderRequest() {
      sourceBody.tools[0].input_schema.properties.replace_all.default = true;
      return {
        response: new Response(
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [part] }, finishReason: "STOP" }],
          })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        ),
        url: "https://synthetic.invalid",
        headers: {},
        transformedBody: { contents: history },
      };
    },
  });
  assert.equal(result.kind, "ok");
  assertClientReplay([part]);
});

test("sequential history uses original calls and concurrent captures isolate defaults", async () => {
  store.captureAgyEnterpriseReplayParts(state(), [part], true);
  const originalHistory = [
    ...history,
    { role: "model", parts: [part] },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            id: call.id,
            name: call.name,
            response: { result: "already succeeded" },
          },
        },
      ],
    },
  ];
  const second = {
    functionCall: { ...call, id: "next-step" },
    thoughtSignature: "second-signature",
  };
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: originalHistory },
    [second],
    true
  );
  const translated = claudeToGeminiRequest(
    model,
    {
      messages: [
        { role: "user", content: "synthetic task" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: { ...args, replace_all: false },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: call.id, content: "already succeeded" }],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: second.functionCall.id,
              name: call.name,
              input: { ...args, replace_all: false },
            },
          ],
        },
      ],
    },
    false,
    credentials
  );
  assert.deepEqual(translated.contents[1].parts, [part]);
  assert.deepEqual(translated.contents[3].parts, [second]);

  await Promise.all(
    [false, true].map(async (defaultValue) => {
      const connection = `concurrent-${defaultValue}`;
      const declaration = {
        ...schema(),
        properties: {
          ...schema().properties,
          replace_all: { type: "boolean", default: defaultValue },
        },
      };
      const transform = createSSEStream({
        targetFormat: "gemini",
        sourceFormat: "claude",
        provider: "agy-enterprise",
        connectionId: connection,
        model,
        body: { contents: history },
        enterpriseReplaySchemas: new Map([["Edit", declaration]]),
      });
      await new Response(
        new Response(
          `data: ${JSON.stringify({
            candidates: [{ content: { parts: [part] }, finishReason: "STOP" }],
          })}\n\n`
        ).body!.pipeThrough(transform)
      ).text();
      const incoming = { ...call, args: { ...args, replace_all: defaultValue } };
      const ns = store.buildAgyEnterpriseReplayNamespace(connection, model);
      assert.deepEqual(
        store.getAgyEnterpriseCallReplay(ns, incoming, [incoming], history)?.nativePart,
        part
      );
      const wrong = { ...call, args: { ...args, replace_all: !defaultValue } };
      assert.equal(store.getAgyEnterpriseCallReplay(ns, wrong, [wrong], history), null);
    })
  );
});

for (const endpoint of ["/v1/messages", "/v1/chat/completions", "/v1/responses"])
  for (const stream of [false, true]) {
    test(`handler resumes inserted defaults ${endpoint} ${stream ? "streaming" : "buffered"}`, async (t) => {
      const claude = endpoint === "/v1/messages";
      const responses = endpoint === "/v1/responses";
      const connectionId = `${endpoint}-${stream}-defaults`;
      const tools = claude
        ? [{ name: "Edit", input_schema: schema() }]
        : responses
          ? [{ type: "function", name: "Edit", parameters: schema() }]
          : [{ type: "function", function: { name: "Edit", parameters: schema() } }];
      const messages: Array<Record<string, unknown>> = [
        { role: "user", content: "synthetic task" },
      ];
      let sent: Record<string, unknown>;
      let requests = 0;
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        requests++;
        const parts =
          requests === 1
            ? [part]
            : [{ text: "synthetic continuation", thoughtSignature: "final-signature" }];
        return new Response(
          `data: ${JSON.stringify({ candidates: [{ content: { parts }, finishReason: "STOP" }] })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        );
      });
      const send = () => {
        const body = {
          model: `agy-enterprise/${model}`,
          stream,
          max_tokens: 2048,
          tools,
          ...(responses ? { input: messages } : { messages }),
        };
        return handleChatCore({
          body,
          modelInfo: { provider: "agy-enterprise", model },
          credentials: {
            accessToken: "synthetic",
            providerSpecificData: {
              projectId: "synthetic",
              location: "us",
              userTier: "standard",
            },
          },
          connectionId,
          clientRawRequest: { endpoint, body: structuredClone(body), headers: new Headers() },
          log: { debug() {}, info() {}, warn() {}, error() {} },
          apiKeyInfo: { noLog: true },
          onCredentialsRefreshed: undefined,
          onRequestSuccess: undefined,
          onStreamFailure: undefined,
          onDisconnect: undefined,
          userAgent: null,
          comboName: null,
        });
      };
      const first = await send();
      assert.ok(!(first instanceof Response));
      assert.equal(first.success, true, JSON.stringify(first));
      assert.match(await first.response.text(), /edit-default/);
      const inserted = { ...args, replace_all: false };
      if (claude)
        messages.push(
          {
            role: "assistant",
            content: [{ type: "tool_use", id: call.id, name: call.name, input: inserted }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: call.id, content: "already succeeded" }],
          }
        );
      else if (responses)
        messages.push(
          {
            type: "function_call",
            call_id: call.id,
            name: call.name,
            arguments: JSON.stringify(inserted),
          },
          { type: "function_call_output", call_id: call.id, output: "already succeeded" }
        );
      else
        messages.push(
          {
            role: "assistant",
            tool_calls: [
              {
                type: "function",
                id: call.id,
                function: { name: call.name, arguments: JSON.stringify(inserted) },
              },
            ],
          },
          { role: "tool", tool_call_id: call.id, content: "already succeeded" }
        );
      const second = await send();
      assert.ok(!(second instanceof Response));
      assert.equal(second.success, true, JSON.stringify(second));
      assert.match(await second.response.text(), /synthetic continuation/);
      assert.equal(requests, 2);
      const contents = sent!.contents as Array<{ parts: Array<Record<string, unknown>> }>;
      assert.deepEqual(contents[1].parts, [part]);
      assert.ok(JSON.stringify(contents[2]).includes("already succeeded"));
      assert.ok(!JSON.stringify(sent!).includes("enterpriseReplaySchemas"));
    });
  }
