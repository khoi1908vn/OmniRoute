import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgyEnterpriseExecutor } from "../../open-sse/executors/agyEnterprise.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
const model = "gemini-3.8-flash-high";
const credentials = {
  _provider: "agy-enterprise",
  accessToken: "synthetic",
  providerSpecificData: { projectId: "project", location: "us", userTier: "standard" },
};
const native = JSON.parse(
  readFileSync(
    new URL("../fixtures/agy-enterprise/captured-protocol/flow-43.request.json", import.meta.url),
    "utf8"
  )
).contents.at(-1);
const data = native.parts[1].inlineData.data;
test.after(() => resetDbInstance());

test("enterprisePngMatchesCaptureAcrossClients", () => {
  const text = native.parts[0].text;
  const image = { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } };
  const requests = [
    openaiToGeminiRequest(
      model,
      { messages: [{ role: "user", content: [{ type: "text", text }, image] }] },
      false,
      credentials
    ),
    claudeToGeminiRequest(
      model,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text },
              { type: "image", source: { type: "base64", media_type: "image/png", data } },
            ],
          },
        ],
      },
      false,
      credentials
    ),
    translateRequest(
      "openai-responses",
      "gemini",
      model,
      {
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text },
              { type: "input_image", image_url: image.image_url.url },
            ],
          },
        ],
      },
      false,
      credentials,
      "agy-enterprise"
    ),
  ];
  for (const request of requests) {
    const output = new AgyEnterpriseExecutor().transformRequest(model, request, false, credentials);
    assert.deepEqual(output.contents, [native]);
  }
});

test("enterpriseUnverifiedMediaRejected before fetch", async (t) => {
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    dispatches++;
    return new Response();
  });
  const executor = new AgyEnterpriseExecutor();
  for (const part of [
    { inlineData: { mimeType: "image/png", data: "%%%" } },
    { inlineData: { mimeType: "image/png", data: "dGV4dA==" } },
    { inlineData: { mimeType: "image/jpeg", data } },
    { inlineData: { mimeType: "application/pdf", data } },
    { inlineData: { mimeType: "audio/wav", data } },
    { fileData: { mimeType: "image/png", fileUri: "https://example.invalid/image.png" } },
  ]) {
    const result = await executor.execute({
      model,
      body: { contents: [{ role: "user", parts: [part] }] },
      stream: false,
      credentials,
    });
    assert.ok(result instanceof Response);
    assert.equal(result.status, 400);
    assert.doesNotMatch(JSON.stringify(await result.json()), /at \/|stack/);
  }
  for (const content of [
    [{ type: "image", source: { type: "url", url: "http://example.invalid/png" } }],
    [{ type: "document", source: { type: "base64", media_type: "application/pdf", data } }],
    [
      {
        type: "tool_result",
        tool_use_id: "call_1",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      },
    ],
  ])
    assert.throws(
      () =>
        claudeToGeminiRequest(model, { messages: [{ role: "user", content }] }, false, credentials),
      /unverified.*media/i
    );
  for (const content of [
    [{ type: "video", video_url: "https://example.invalid/video" }],
    [{ type: "image_url", image_url: { url: "https://example.invalid/png" } }],
    [{ type: "audio_url", audio_url: { url: "https://example.invalid/audio" } }],
  ])
    assert.throws(
      () =>
        openaiToGeminiRequest(model, { messages: [{ role: "user", content }] }, false, credentials),
      /unverified.*media/i
    );
  assert.equal(dispatches, 0);
});
