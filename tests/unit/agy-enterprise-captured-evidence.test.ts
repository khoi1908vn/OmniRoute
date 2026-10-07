import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { crc32, inflateSync } from "node:zlib";

const root = new URL("../fixtures/agy-enterprise/captured-protocol/", import.meta.url);
const request = (index: number) =>
  JSON.parse(fs.readFileSync(new URL(`flow-${index}.request.json`, root), "utf8"));
const response = (index: number): Array<Record<string, unknown>> =>
  fs
    .readFileSync(new URL(`flow-${index}.response.sse`, root), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5)));

test("captured text has root Gemini SSE and a signature-only terminal part", () => {
  const events = response(23);
  assert.equal(events.length, 2);
  assert.equal(events[0].response, undefined);
  const terminal = events[1] as {
    candidates: Array<{
      content: { parts: Array<{ text: string; thoughtSignature: string }> };
      finishReason: string;
    }>;
    usageMetadata: { totalTokenCount: number };
  };
  assert.equal(terminal.candidates[0].finishReason, "STOP");
  assert.equal(terminal.candidates[0].content.parts[0].text, "");
  assert.match(terminal.candidates[0].content.parts[0].thoughtSignature, /^SYNTHETIC_SIGNATURE_/);
  assert.equal(terminal.usageMetadata.totalTokenCount, 119);
});

test("captured sequential calls replay IDs, arguments and signatures with model-role results", () => {
  for (const [outbound, continuation] of [
    [33, 35],
    [35, 38],
  ]) {
    const events = response(outbound) as Array<{
      candidates: Array<{ content: { parts: Array<Record<string, unknown>> } }>;
    }>;
    const call = events.flatMap((e) => e.candidates[0].content.parts).find((p) => p.functionCall)!;
    const history = request(continuation).contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const replay = history
      .flatMap((c) => c.parts)
      .find(
        (p) =>
          (p.functionCall as { id: string } | undefined)?.id ===
          (call.functionCall as { id: string }).id
      )!;
    assert.deepEqual(replay.functionCall, call.functionCall);
    assert.equal(replay.thoughtSignature, call.thoughtSignature);
    const resultTurn = history.find((c) =>
      c.parts.some(
        (p) =>
          (p.functionResponse as { id: string } | undefined)?.id ===
          (call.functionCall as { id: string }).id
      )
    )!;
    assert.equal(resultTurn.role, "model");
    assert.deepEqual(
      Object.keys((resultTurn.parts[0].functionResponse as { response: object }).response),
      ["output"]
    );
  }
  assert.equal(request(33).toolConfig, undefined);
  assert.equal(request(33).tools.length, 13);
});

test("image fixture keeps inline PNG structure and accounting with synthetic image bytes", () => {
  const image = request(43)
    .contents.at(-1)
    .parts.find((p: Record<string, unknown>) => p.inlineData).inlineData;
  assert.equal(image.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.readUInt32BE(16), 1);
  assert.equal(bytes.readUInt32BE(20), 1);
  assert.equal(crc32(bytes.subarray(37, 52)), bytes.readUInt32BE(52));
  assert.equal(inflateSync(bytes.subarray(41, 52)).length, 3);
  const usage = response(43).at(-1)!.usageMetadata as {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
    totalTokenCount: number;
  };
  assert.equal(
    usage.promptTokenCount + usage.candidatesTokenCount + usage.thoughtsTokenCount,
    usage.totalTokenCount
  );
  assert.equal(usage.totalTokenCount, 15076);
});

test("evidence headers contain placeholders and no live authorization or project", () => {
  for (const i of [23, 25, 33, 35, 38, 43]) {
    const metadata = JSON.parse(fs.readFileSync(new URL(`flow-${i}.http.json`, root), "utf8"));
    assert.match(metadata.request.url, /projects\/SANITIZED_PROJECT\/locations\/us/);
    assert.equal(
      metadata.request.headers.find(
        (h: { name: string }) => h.name.toLowerCase() === "authorization"
      ).value,
      "Bearer SANITIZED_TOKEN"
    );
  }
});
