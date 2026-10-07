import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSSEToGeminiResponse } from "../../open-sse/handlers/sseParser/geminiResponse.ts";
import { parseNonStreamingResponseBody } from "../../open-sse/handlers/chatCore/nonStreamingResponseParse.ts";
import {
  buildAgyEnterpriseReplayNamespace,
  getAgyEnterpriseCallSignature,
  getAgyEnterpriseTextSignature,
  clearGeminiThoughtSignatures,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

const model = "gemini-3.8-flash-high";
const context = { provider: "agy-enterprise", connectionId: "buffer-account", experience: model };
const raw = (flow: number) =>
  readFileSync(
    new URL(
      `../fixtures/agy-enterprise/captured-protocol/flow-${flow}.response.sse`,
      import.meta.url
    ),
    "utf8"
  );
type Completion = {
  choices: Array<{
    message: { content: string; reasoning_content?: string; tool_calls?: Array<{ id: string }> };
    finish_reason: string;
  }>;
  usage: Record<string, unknown>;
};
test.after(() => resetDbInstance());

test("enterpriseBufferedMatchesCapturedStream", () => {
  for (const flow of [33, 35, 43]) {
    const sse = raw(flow);
    const result = parseSSEToGeminiResponse(sse, model, context) as Completion;
    const parts = sse
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data: "))
      .flatMap((l) => JSON.parse(l.slice(6)).candidates?.[0]?.content?.parts || []);
    assert.equal(
      result.choices[0].message.reasoning_content,
      parts
        .filter((p) => p.thought)
        .map((p) => p.text || "")
        .join("")
    );
    assert.equal(
      result.choices[0].message.content,
      parts
        .filter((p) => !p.thought)
        .map((p) => p.text || "")
        .join("") || null
    );
    if (flow !== 43) {
      assert.equal(result.choices[0].finish_reason, "tool_calls");
      assert.equal(result.choices[0].message.tool_calls[0].id, flow === 33 ? "call_1" : "call_2");
    } else {
      assert.deepEqual(result.usage, {
        prompt_tokens: 13682,
        completion_tokens: 1394,
        total_tokens: 15076,
        prompt_tokens_details: { cached_tokens: 11179 },
        completion_tokens_details: { reasoning_tokens: 946 },
      });
    }
  }
});

test("enterpriseBufferedReplayPersists", () => {
  clearGeminiThoughtSignatures();
  const namespace = buildAgyEnterpriseReplayNamespace(context.connectionId, model);
  parseSSEToGeminiResponse(raw(33), model, context);
  const original = raw(33)
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data: "))
    .flatMap((line) => JSON.parse(line.slice(6)).candidates?.[0]?.content?.parts || [])
    .find((part) => part.functionCall).functionCall;
  assert.ok(getAgyEnterpriseCallSignature(namespace, original));
  const result = parseSSEToGeminiResponse(raw(25), model, context) as Completion;
  assert.ok(getAgyEnterpriseTextSignature(namespace, result.choices[0].message.content));
});

test("Enterprise malformed/truncated streams never store a partial text signature", async () => {
  clearGeminiThoughtSignatures();
  const part =
    'data: {"candidates":[{"content":{"parts":[{"text":"partial","thoughtSignature":"c2ln"}]}}]}\r\n\r\n';
  assert.equal(parseSSEToGeminiResponse(part + "data: {bad\r\n\r\n", model, context), null);
  const result = await parseNonStreamingResponseBody({
    providerResponse: new Response(
      part + 'data: {"error":{"code":503,"message":"failure"}}\r\n\r\n',
      { headers: { "content-type": "text/event-stream" } }
    ),
    upstreamStream: true,
    providerHeaders: {},
    finalBody: {},
    targetFormat: "gemini",
    model,
    geminiReplayContext: context,
  });
  assert.equal(result.kind, "invalid_sse");
  assert.equal(
    getAgyEnterpriseTextSignature(
      buildAgyEnterpriseReplayNamespace(context.connectionId, model),
      "partial"
    ),
    null
  );
});

test("Enterprise terminal-only response cancels the reader and keeps terminal usage", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(
        new TextEncoder().encode(
          'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9}}\r\n\r\n'
        )
      );
    },
    cancel() {
      cancelled = true;
    },
  });
  const result = await parseNonStreamingResponseBody({
    providerResponse: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    upstreamStream: true,
    providerHeaders: {},
    finalBody: {},
    targetFormat: "gemini",
    model,
    geminiReplayContext: context,
  });
  assert.equal(result.kind, "ok");
  if (result.kind === "ok")
    assert.deepEqual(result.responseBody.usage, {
      prompt_tokens: 7,
      completion_tokens: 2,
      total_tokens: 9,
    });
  assert.equal(cancelled, true);
});
