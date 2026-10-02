import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function fixture(name: string) {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/agy-enterprise/${name}.json`, import.meta.url), "utf8")
  );
}

test("observed Enterprise title request uses root Gemini content and entitlement", () => {
  const body = fixture("title-request");
  assert.equal(body.aicode.experience, "gemini-3.5-flash-lite");
  assert.equal(body.entitlement.userTier, fixture("licenses").licenses[0].userTier);
  assert.deepEqual(body.contents, [{ parts: [{ text: "Hello" }], role: "user" }]);
  assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0);
  for (const field of ["request", "project", "model", "requestId", "requestType", "userAgent"]) {
    assert.equal(field in body, false);
  }
});

test("terminal signature-only event retains finish and independently accounted reasoning usage", () => {
  const event = fixture("terminal");
  assert.equal(event.candidates[0].finishReason, "STOP");
  assert.equal(event.candidates[0].content.parts[0].text, "");
  assert.equal(
    event.candidates[0].content.parts[0].thoughtSignature,
    "[NOT_TRANSCRIBED_FROM_SCREENSHOT]"
  );
  const usage = event.usageMetadata;
  assert.equal(usage.candidatesTokenCount + usage.thoughtsTokenCount, 84);
  assert.equal(usage.promptTokenCount + 84, usage.totalTokenCount);
});
