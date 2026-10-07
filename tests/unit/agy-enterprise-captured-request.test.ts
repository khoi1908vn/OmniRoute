import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgyEnterpriseExecutor } from "../../open-sse/executors/agyEnterprise.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import * as helpers from "../../open-sse/translator/request/openai-to-gemini/helpers.ts";
import {
  storeAgyEnterpriseCallSignature,
  buildAgyEnterpriseReplayNamespace,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";

import { resetDbInstance } from "../../src/lib/db/core.ts";
test.after(() => resetDbInstance());

const model = "gemini-3.8-flash-high";
const credentials = {
  _provider: "agy-enterprise",
  accessToken: "synthetic",
  providerSpecificData: { projectId: "project-one", location: "us", userTier: "standard" },
};

test("System context after the user task stays in systemInstruction", () => {
  const body = {
    system: [{ type: "text", text: "Workspace: synthetic-project." }],
    messages: [
      { role: "user", content: "Analyze this project." },
      { role: "system", content: "Harness context only." },
      { role: "developer", content: [{ type: "text", text: "Inspect files first.\n" }] },
    ],
  };
  const before = structuredClone(body);
  const result = claudeToGeminiRequest(model, body, false, credentials);
  assert.deepEqual(result.systemInstruction, {
    role: "user",
    parts: [
      { text: "Workspace: synthetic-project.\nHarness context only.\nInspect files first.\n" },
    ],
  });
  assert.deepEqual(result.contents, [{ role: "user", parts: [{ text: "Analyze this project." }] }]);
  assert.deepEqual(body, before);
});

test("Instruction order survives interleaved conversation", () => {
  const result = claudeToGeminiRequest(
    model,
    {
      system: " first ",
      messages: [
        { role: "user", content: "task" },
        {
          role: "system",
          content: [
            { type: "text", text: "second\n" },
            { type: "text", text: "third" },
          ],
        },
        { role: "user", content: "followup" },
        { role: "DEVELOPER", content: " fourth " },
      ],
    },
    false,
    credentials
  );
  assert.equal(result.systemInstruction.parts[0].text, " first \nsecond\n\nthird\n fourth ");
  assert.deepEqual(result.contents, [
    { role: "user", parts: [{ text: "task" }] },
    { role: "user", parts: [{ text: "followup" }] },
  ]);
});

test("User hook reminders remain conversation content", () => {
  const result = claudeToGeminiRequest(
    model,
    {
      messages: [
        {
          role: "user",
          content: "<system-reminder>projectSessionStart: Harness context only.</system-reminder>",
        },
      ],
    },
    false,
    credentials
  );
  assert.equal(result.systemInstruction, undefined);
  assert.deepEqual(result.contents, [
    {
      role: "user",
      parts: [
        { text: "<system-reminder>projectSessionStart: Harness context only.</system-reminder>" },
      ],
    },
  ]);
});

test("Empty instructions create no empty systemInstruction", () => {
  for (const content of [
    "",
    [],
    [
      { type: "text", text: "" },
      { type: "text", text: "" },
    ],
  ]) {
    const result = claudeToGeminiRequest(
      model,
      {
        messages: [
          { role: "system", content },
          { role: "user", content: "task" },
        ],
      },
      false,
      credentials
    );
    assert.equal(result.systemInstruction, undefined);
    assert.deepEqual(result.contents, [{ role: "user", parts: [{ text: "task" }] }]);
  }
});

test("Generic Gemini preserves its systemInstruction role", () => {
  const result = claudeToGeminiRequest(
    "gemini-2.5-flash",
    {
      system: "first",
      messages: [
        { role: "system", content: "second" },
        { role: "user", content: "task" },
      ],
    },
    false,
    { _provider: "gemini" }
  );
  assert.deepEqual(result.systemInstruction, {
    role: "system",
    parts: [{ text: "first\nsecond" }],
  });
  assert.deepEqual(result.contents, [{ role: "user", parts: [{ text: "task" }] }]);
});

test("Instruction extraction preserves caller metadata", () => {
  const body = {
    system: [{ type: "text", text: "first", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "developer",
        content: [{ type: "text", text: "second", cache_control: { type: "ephemeral" } }],
      },
      { role: "user", content: "task" },
    ],
    tools: [
      {
        name: "inspect_workspace",
        input_schema: { type: "object", properties: {} },
        cache_control: { type: "ephemeral" },
      },
    ],
  };
  const before = structuredClone(body);
  const result = claudeToGeminiRequest(model, body, false, credentials);
  assert.deepEqual(body, before);
  assert.equal(result.systemInstruction.parts[0].text, "first\nsecond");
  assert.equal(result.tools[0].functionDeclarations[0].name, "inspect_workspace");
});

test("Nontext instruction blocks fail without leaking values", () => {
  for (const block of [
    { type: "image", source: { type: "url", url: "https://example.com/synthetic-secret" } },
    { type: "tool_use", id: "synthetic-secret", name: "read", input: {} },
  ]) {
    assert.throws(
      () =>
        claudeToGeminiRequest(
          model,
          {
            messages: [
              { role: "system", content: [block] },
              { role: "user", content: "task" },
            ],
          },
          false,
          credentials
        ),
      (error: Error & { statusCode?: number }) => {
        assert.equal(error.statusCode, 400);
        assert.equal(
          error.message,
          "Unsupported Gemini instruction content: only text blocks are supported"
        );
        assert.ok(!error.message.includes("synthetic-secret"));
        return true;
      }
    );
  }
});
const fixture = (flow: number) =>
  JSON.parse(
    readFileSync(
      new URL(
        `../fixtures/agy-enterprise/captured-protocol/flow-${flow}.request.json`,
        import.meta.url
      ),
      "utf8"
    )
  );

test("enterpriseNativeToolLoopMatchesCapture", () => {
  const executor = new AgyEnterpriseExecutor();
  for (const flow of [33, 35, 38]) {
    const body = fixture(flow);
    const output = executor.transformRequest(model, body, false, credentials);
    assert.deepEqual(output.contents, body.contents);
    assert.deepEqual(output.tools, body.tools);
    assert.equal(output.aicode.experience, model);
    assert.equal(output.entitlement.userTier, "standard");
  }
});

test("enterpriseClientToolResultsMatchCapture", () => {
  const normalize = helpers["normalizeAgyEnterpriseContents"];
  assert.equal(typeof normalize, "function");
  const call = { functionCall: { id: "call_1", name: "read", args: {} }, thoughtSignature: "c2ln" };
  const result = {
    functionResponse: { id: "call_1", name: "read", response: { result: "error" } },
  };
  assert.deepEqual(
    normalize([
      { role: "model", parts: [call] },
      { role: "user", parts: [{ text: "before" }, result, { text: "after" }] },
    ]),
    [
      { role: "model", parts: [call] },
      { role: "user", parts: [{ text: "before" }] },
      {
        role: "model",
        parts: [
          { functionResponse: { id: "call_1", name: "read", response: { output: "error" } } },
        ],
      },
      { role: "user", parts: [{ text: "after" }] },
    ]
  );
});

test("enterpriseDefaultsMatchCapture", () => {
  for (const budget of [-1, 0]) {
    const generationConfig = {
      maxOutputTokens: 65536,
      thinkingConfig: { thinkingBudget: budget, includeThoughts: true },
    };
    const tools = [
      { type: "function", function: { name: "read", parameters: { type: "object" } } },
    ];
    const openai = openaiToGeminiRequest(
      model,
      {
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "hi" },
        ],
        tools,
        tool_choice: "auto",
        generationConfig,
      },
      false,
      credentials
    );
    const claude = claudeToGeminiRequest(
      model,
      {
        system: "system",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "read", input_schema: { type: "object" } }],
        tool_choice: { type: "auto" },
        generationConfig,
      },
      false,
      credentials
    );
    for (const output of [openai, claude]) {
      assert.equal(output.systemInstruction.role, "user");
      assert.equal(output.toolConfig, undefined);
      assert.equal(output.safetySettings, undefined);
      assert.deepEqual(output.generationConfig, generationConfig);
    }
  }
  const generic = openaiToGeminiRequest(
    model,
    { messages: [{ role: "user", content: "hi" }] },
    false
  );
  assert.ok(generic.safetySettings);
});

test("Enterprise rejects unverified tool modes and malformed native parts before fetch", async (t) => {
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    dispatches++;
    return new Response();
  });
  const executor = new AgyEnterpriseExecutor();
  for (const part of [
    { functionCall: { id: "", name: "read", args: {} } },
    { functionCall: { id: "a", name: "read", args: "bad" } },
    { functionResponse: { id: "a", name: "read", response: { output: {} } } },
  ]) {
    const output = await executor.execute({
      model,
      body: { contents: [{ role: "model", parts: [part] }] },
      stream: false,
      credentials,
    });
    assert.ok(output instanceof Response);
    assert.equal(output.status, 400);
    assert.doesNotMatch(JSON.stringify(await output.json()), /at \/|stack/);
  }
  for (const choice of ["none", "required", { type: "function", function: { name: "read" } }]) {
    assert.throws(
      () =>
        openaiToGeminiRequest(
          model,
          { messages: [{ role: "user", content: "hi" }], tool_choice: choice },
          false,
          credentials
        ),
      /unverified.*mode/i
    );
  }
  assert.equal(dispatches, 0);
});

test("Enterprise compression cannot alter signed call history after translation", async (t) => {
  const namespace = buildAgyEnterpriseReplayNamespace("compression-account", model);
  storeAgyEnterpriseCallSignature(
    namespace,
    { id: "signed-call", name: "read", args: { path: "original" } },
    "c2ln",
    [{ role: "user", parts: [{ text: "read" }] }]
  );
  const translated = openaiToGeminiRequest(
    model,
    {
      messages: [
        { role: "user", content: "read" },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "signed-call",
              type: "function",
              function: { name: "read", arguments: '{"path":"original"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "signed-call", content: "original result" },
      ],
    },
    false,
    { ...credentials, _signatureNamespace: "compression-account" }
  );
  translated.contents[1].parts[0].functionCall.args.path = "changed";
  let dispatched = false;
  t.mock.method(globalThis, "fetch", async () => {
    dispatched = true;
    return new Response();
  });
  const result = await new AgyEnterpriseExecutor().execute({
    model,
    body: translated,
    credentials,
    stream: false,
  });
  assert.ok(result instanceof Response);
  assert.equal(result.status, 400);
  assert.equal(dispatched, false);
});

test("Enterprise request tests use isolated storage", () => {
  assert.match(process.env.DATA_DIR || "", /omniroute-test/);
});
