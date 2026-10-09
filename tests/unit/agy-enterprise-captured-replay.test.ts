import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as store from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.ts";
import { geminiToClaudeResponse } from "../../open-sse/translator/response/gemini-to-claude.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

const model = "gemini-3.8-flash-high";
const credentials = { _provider: "agy-enterprise", _signatureNamespace: "account-one" };
const events = (flow: number): Array<Record<string, unknown>> =>
  readFileSync(
    new URL(
      `../fixtures/agy-enterprise/captured-protocol/flow-${flow}.response.sse`,
      import.meta.url
    ),
    "utf8"
  )
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
test.after(() => resetDbInstance());

test("enterpriseTextTailSignatureReplays", () => {
  for (const convert of [geminiToOpenAIResponse, geminiToClaudeResponse]) {
    store.clearGeminiThoughtSignatures();
    const state = {
      provider: "agy-enterprise",
      signatureNamespace: store["buildAgyEnterpriseReplayNamespace"]?.("account-one", model),
      toolCalls: new Map(),
    };
    const text = "hello world";
    for (const part of [
      { thought: true, text: "private reasoning" },
      { text: "hello " },
      { text: "world" },
      { text: "", thoughtSignature: "c3ludGhldGljLXRleHQ=" },
    ]) {
      convert(
        {
          candidates: [
            {
              content: { parts: [part] },
              ...(part.thoughtSignature ? { finishReason: "STOP" } : {}),
            },
          ],
        },
        state
      );
    }
    const openai = openaiToGeminiRequest(
      model,
      {
        messages: [
          { role: "assistant", content: text },
          { role: "user", content: "next" },
        ],
      },
      false,
      credentials
    );
    const claude = claudeToGeminiRequest(
      model,
      {
        messages: [
          { role: "assistant", content: [{ type: "text", text }] },
          { role: "user", content: "next" },
        ],
      },
      false,
      credentials
    );
    for (const result of [openai, claude])
      assert.deepEqual(result.contents[0], {
        role: "model",
        parts: [{ text, thoughtSignature: "c3ludGhldGljLXRleHQ=" }],
      });
  }
});

test("enterpriseCallSignatureReplaysBothPaths", () => {
  for (const convert of [geminiToOpenAIResponse, geminiToClaudeResponse]) {
    store.clearGeminiThoughtSignatures();
    const namespace = store["buildAgyEnterpriseReplayNamespace"]?.("account-one", model);
    const state = {
      provider: "agy-enterprise",
      enterpriseReplayHistory: [{ role: "user", parts: [{ text: "read" }] }],
      signatureNamespace: namespace,
      toolCalls: new Map(),
    };
    for (const event of events(33)) convert(event, state);
    const original = events(33)
      .flatMap(
        (event) =>
          (event.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }>)?.[0]
            ?.content?.parts || []
      )
      .find((part) => part.functionCall).functionCall as {
      id: string;
      name: string;
      args: unknown;
    };
    const signature = store.getAgyEnterpriseCallSignature(
      namespace,
      original,
      state.enterpriseReplayHistory
    );
    assert.ok(signature);
    store.setGeminiThoughtSignatureMode("bypass");
    const openai = openaiToGeminiRequest(
      model,
      {
        messages: [
          { role: "user", content: "read" },
          {
            role: "assistant",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                thoughtSignature: "REg==",
                function: { name: "run_command", arguments: JSON.stringify(original.args) },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "error" },
        ],
      },
      false,
      credentials
    );
    const claude = claudeToGeminiRequest(
      model,
      {
        messages: [
          { role: "user", content: "read" },
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "run_command",
                input: original.args,
                thoughtSignature: "REg==",
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "before" },
              { type: "tool_result", tool_use_id: "call_1", content: "error" },
              { type: "text", text: "after" },
            ],
          },
        ],
      },
      false,
      credentials
    );
    for (const result of [openai, claude]) {
      assert.equal(result.contents[1].parts[0].thoughtSignature, signature);
      const response = result.contents.find((c) => c.parts[0].functionResponse);
      assert.equal(response.role, "model");
      assert.deepEqual(response.parts[0].functionResponse.response, { output: "error" });
    }
    assert.deepEqual(
      claude.contents.slice(2).map((c) => c.role),
      ["user", "model", "user"]
    );
  }
});

test("enterpriseReplayScopeIsolation and persistence recovery", () => {
  const build = store["buildAgyEnterpriseReplayNamespace"];
  assert.equal(typeof build, "function");
  const namespace = build("one", model);
  store["storeAgyEnterpriseTextSignature"](namespace, "same text", "c2lnMQ==");
  store.clearGeminiThoughtSignatureMemoryForTests();
  assert.equal(store["getAgyEnterpriseTextSignature"](namespace, "same text"), "c2lnMQ==");
  for (const other of [build("two", model), build("one", "other"), "one"])
    assert.equal(store["getAgyEnterpriseTextSignature"](other, "same text"), null);
  store["storeAgyEnterpriseTextSignature"](namespace, "same text", "c2lnMg==");
  store.clearGeminiThoughtSignatureMemoryForTests();
  assert.equal(store["getAgyEnterpriseTextSignature"](namespace, "same text"), null);
  store["storeAgyEnterpriseTextSignature"](namespace, "same text", "c2lnMQ==");
  assert.equal(store["getAgyEnterpriseTextSignature"](namespace, "same text"), null);
  assert.throws(() => build("", model), /replay/);
});

test("missing Enterprise replay fails explicitly without fabricated context or client signatures", () => {
  assert.throws(
    () =>
      openaiToGeminiRequest(
        model,
        { messages: [{ role: "assistant", content: "unknown history" }] },
        false,
        credentials
      ),
    /replay/
  );
  assert.throws(
    () =>
      claudeToGeminiRequest(
        model,
        {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "missing",
                  name: "read",
                  input: {},
                  thoughtSignature: "c2ln",
                },
              ],
            },
          ],
        },
        false,
        credentials
      ),
    /replay/
  );
});
