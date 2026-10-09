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
  getAgyEnterpriseTextReplay,
  captureAgyEnterpriseReplayParts,
  clearGeminiThoughtSignatures,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { createSSEStream } from "../../open-sse/utils/stream.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.ts";

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

test("Malformed streaming data followed by STOP never grants text replay", async () => {
  const history = [{ role: "user", parts: [{ text: "Read only." }] }];
  const rebuilt = [
    {
      role: "user",
      parts: [{ text: '<teammate-message teammate_id="reader">Done</teammate-message>' }],
    },
  ];
  for (const format of ["claude", "openai"]) {
    for (const middle of ["data: {malformed\n\n", ": heartbeat\n\nevent: message\n\n"]) {
      clearGeminiThoughtSignatures();
      const payload =
        'data: {"candidates":[{"content":{"parts":[{"text":"Complete report."}]}}]}\n\n' +
        middle +
        'data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}\n\n';
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
      await new Response(
        source.pipeThrough(
          createSSEStream({
            sourceFormat: format,
            targetFormat: "gemini",
            provider: "agy-enterprise",
            model,
            connectionId: context.connectionId,
            body: { contents: history },
          })
        )
      ).text();
      const expected = middle.includes("malformed") ? null : {};
      const namespace = buildAgyEnterpriseReplayNamespace(context.connectionId, model);
      assert.deepEqual(
        getAgyEnterpriseTextReplay(namespace, "Complete report.", [], rebuilt),
        expected,
        format
      );
      clearGeminiThoughtSignatures();
      const buffered = parseSSEToGeminiResponse(payload, model, { ...context, history });
      assert.equal(Boolean(buffered), !middle.includes("malformed"));
      assert.deepEqual(
        getAgyEnterpriseTextReplay(namespace, "Complete report.", [], rebuilt),
        expected
      );
    }
  }
});

test("Only completed plain-text STOP origins recover after teammate wakeup", () => {
  clearGeminiThoughtSignatures();
  const experience = "gemini-3.1-pro-high";
  const connectionId = "unsigned-origin";
  const namespace = buildAgyEnterpriseReplayNamespace(connectionId, experience);
  const history = [
    { role: "user", parts: [{ text: "Earlier request." }] },
    { role: "user", parts: [{ text: "Read-only team." }] },
  ];
  const rebuilt = [
    history[0],
    {
      role: "user",
      parts: [{ text: '<teammate-message teammate_id="reader">Report</teammate-message>' }],
    },
  ];
  const state = () => ({
    provider: "agy-enterprise",
    signatureNamespace: namespace,
    enterpriseReplayHistory: history,
  });
  for (const finish of [undefined, "MAX_TOKENS", "SAFETY", "OTHER"]) {
    const capture = state();
    captureAgyEnterpriseReplayParts(capture, [{ text: "Incomplete." }], false);
    captureAgyEnterpriseReplayParts(capture, [], true, finish);
    assert.equal(getAgyEnterpriseTextReplay(namespace, "Incomplete.", [], history), null);
    assert.equal(getAgyEnterpriseTextReplay(namespace, "Incomplete.", [], rebuilt), null);
  }
  const mixedThought = state();
  captureAgyEnterpriseReplayParts(
    mixedThought,
    [
      { thought: true, text: "Reasoning one.", thoughtSignature: "native-thought-signature" },
      { thought: true, text: "Reasoning two." },
      { text: "Visible answer." },
    ],
    false
  );
  captureAgyEnterpriseReplayParts(mixedThought, [], true, "STOP");
  assert.deepEqual(getAgyEnterpriseTextReplay(namespace, "Visible answer.", [], history), {});

  for (const extra of [
    { functionCall: { name: "read", args: {}, id: "unsigned-call" } },
    { inlineData: {} },
  ]) {
    const capture = state();
    captureAgyEnterpriseReplayParts(capture, [extra], false);
    captureAgyEnterpriseReplayParts(capture, [{ text: "Unsupported." }], true, "STOP");
    assert.equal(getAgyEnterpriseTextReplay(namespace, "Unsupported.", [], history), null);
    assert.equal(getAgyEnterpriseTextReplay(namespace, "Unsupported.", [], rebuilt), null);
  }
  const capture = state();
  captureAgyEnterpriseReplayParts(capture, [{ text: "Complete." }], false);
  assert.equal(getAgyEnterpriseTextReplay(namespace, "Complete.", [], history), null);
  assert.equal(getAgyEnterpriseTextReplay(namespace, "Complete.", [], rebuilt), null);
  captureAgyEnterpriseReplayParts(capture, [{ text: "" }], true, "STOP");
  assert.deepEqual(getAgyEnterpriseTextReplay(namespace, "Complete.", [], history), {});
  assert.deepEqual(getAgyEnterpriseTextReplay(namespace, "Complete.", [], rebuilt), {});
  for (const [scope, text, origin] of [
    [buildAgyEnterpriseReplayNamespace("other", experience), "Complete.", history],
    [buildAgyEnterpriseReplayNamespace(connectionId, "gemini-3.1-pro-low"), "Complete.", history],
    [namespace, "Complete. altered", history],
    [namespace, "Complete.", []],
  ] as const)
    assert.equal(getAgyEnterpriseTextReplay(scope, text, [], origin), null);
  assert.equal(
    getAgyEnterpriseTextReplay(
      namespace,
      "Complete.",
      [{ name: "read", args: {}, id: "injected-call" }],
      history
    ),
    null
  );
});

test("Unsigned STOP capture reaches OpenAI translation and buffered SSE replay", () => {
  clearGeminiThoughtSignatures();
  const experience = "gemini-3.1-pro-high";
  const connectionId = "unsigned-other-paths";
  const history = [{ role: "user", parts: [{ text: "Read-only team." }] }];
  const namespace = buildAgyEnterpriseReplayNamespace(connectionId, experience);
  const event = {
    candidates: [{ content: { parts: [{ text: "Complete." }] }, finishReason: "STOP" }],
  };
  geminiToOpenAIResponse(event, {
    provider: "agy-enterprise",
    signatureNamespace: namespace,
    enterpriseReplayHistory: history,
    toolCalls: new Map(),
  });
  const body = {
    messages: [
      { role: "user", content: "Read-only team." },
      { role: "assistant", content: "Complete." },
    ],
  };
  const credentials = { _provider: "agy-enterprise", _signatureNamespace: connectionId };
  assert.deepEqual(openaiToGeminiRequest(experience, body, false, credentials).contents[1].parts, [
    { text: "Complete." },
  ]);
  clearGeminiThoughtSignatures();
  assert.ok(
    parseSSEToGeminiResponse(`data: ${JSON.stringify(event)}\n\n`, experience, {
      provider: "agy-enterprise",
      connectionId,
      experience,
      history,
    })
  );
  assert.deepEqual(getAgyEnterpriseTextReplay(namespace, "Complete.", [], history), {});
});

test("Captured teammate summary ending unsigned STOP must remain replayable", async () => {
  clearGeminiThoughtSignatures();
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/agy-enterprise/captured-protocol/teammate-unsigned-stop.json",
        import.meta.url
      ),
      "utf8"
    )
  ) as { chunks: string[] };
  const nativeParts = fixture.chunks.flatMap(
    (chunk) => JSON.parse(chunk.slice(6)).candidates[0].content.parts
  );
  const text = nativeParts.map((part: { text: string }) => part.text).join("");
  assert.equal(text.length, 2149);
  assert.equal(fixture.chunks.length, 21);
  assert.equal(JSON.parse(fixture.chunks.at(-1).slice(6)).candidates[0].finishReason, "STOP");
  assert.ok(
    nativeParts.every(
      (part: Record<string, unknown>) =>
        Object.keys(part).length === 1 && typeof part.text === "string"
    )
  );
  const incidentModel = "gemini-3.1-pro-high";
  const connectionId = "unsigned-teammate-capture";
  const history = [{ role: "user", parts: [{ text: "Read-only teammate result." }] }];
  let index = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index === fixture.chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(fixture.chunks[index++]));
    },
  });
  const client = await new Response(
    source.pipeThrough(
      createSSEStream({
        sourceFormat: "claude",
        targetFormat: "gemini",
        provider: "agy-enterprise",
        model: incidentModel,
        connectionId,
        body: { contents: history },
      })
    )
  ).text();
  assert.match(client, /message_stop/);
  const emittedText = client
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.delta?.type === "text_delta")
    .map((event) => event.delta.text)
    .join("");
  assert.equal(emittedText, text);
  // Native continuation of these captured unsigned parts returned HTTP 200 in
  // the live protocol control. The proxy must preserve their observed origin.
  const replayed = claudeToGeminiRequest(
    incidentModel,
    {
      messages: [
        { role: "user", content: "Read-only teammate result." },
        { role: "assistant", content: text },
        { role: "user", content: "Teammate idle notification." },
      ],
    },
    true,
    { _provider: "agy-enterprise", _signatureNamespace: connectionId }
  );
  assert.deepEqual(replayed.contents[1].parts, [{ text }]);
});

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
