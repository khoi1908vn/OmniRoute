import fs from "node:fs";
import path from "node:path";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = path.resolve(".build/enterprise-protocol-probe-db");
const { geminiToOpenAIRequest } =
  await import("../../open-sse/translator/request/gemini-to-openai.ts");
const { openaiToGeminiRequest } =
  await import("../../open-sse/translator/request/openai-to-gemini.ts");
const { claudeToGeminiRequest } =
  await import("../../open-sse/translator/request/claude-to-gemini.ts");
const { geminiToClaudeResponse } =
  await import("../../open-sse/translator/response/gemini-to-claude.ts");
const { geminiToOpenAIResponse } =
  await import("../../open-sse/translator/response/gemini-to-openai.ts");
const { parseSSEToGeminiResponse } =
  await import("../../open-sse/handlers/sseParser/geminiResponse.ts");
const { storeGeminiThoughtSignature, buildGeminiThoughtSignatureKey } =
  await import("../../open-sse/services/geminiThoughtSignatureStore.ts");
const dir = "tests/fixtures/agy-enterprise/captured-protocol";
const read = (i, suffix) => fs.readFileSync(`${dir}/flow-${i}.${suffix}`, "utf8");
const request = JSON.parse(read(35, "request.json"));
const callPart = request.contents.flatMap((c) => c.parts).find((p) => p.functionCall);
const call = callPart.functionCall;
const namespace = "offline-synthetic-probe";
storeGeminiThoughtSignature(
  buildGeminiThoughtSignatureKey(namespace, call.id),
  callPart.thoughtSignature
);
const credentials = { _provider: "agy-enterprise", _signatureNamespace: namespace };
const model = request.aicode.experience;
const openai = geminiToOpenAIRequest(model, request, true);
const roundtrip = openaiToGeminiRequest(model, openai, true, credentials);
const claude = {
  system: "Synthetic system",
  tools: [{ name: call.name, input_schema: { type: "object", properties: {} } }],
  messages: [
    { role: "user", content: "Synthetic prompt" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: call.id, name: call.name, input: call.args }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: call.id, content: "Synthetic output", is_error: true },
      ],
    },
  ],
};
const direct = claudeToGeminiRequest(model, claude, true, credentials);
const summary = (body) => ({
  resultTurns: body.contents
    .filter((c) => c.parts.some((p) => p.functionResponse))
    .map((c) => ({
      role: c.role,
      responseKeys: Object.keys(c.parts.find((p) => p.functionResponse).functionResponse.response),
      idMatches: c.parts.find((p) => p.functionResponse).functionResponse.id === call.id,
    })),
  callSignatureRestored:
    body.contents.flatMap((c) => c.parts).find((p) => p.functionCall)?.thoughtSignature ===
    callPart.thoughtSignature,
  systemRole: body.systemInstruction?.role,
  safetySettingsAdded: !!body.safetySettings,
});
const results = {
  openaiRequestRoundtrip: summary(roundtrip),
  directClaudeRequest: summary(direct),
  streams: {},
};
for (const i of [25, 33, 35, 38, 43]) {
  const raw = read(i, "response.sse");
  const events = raw
    .split(/\r?\n/)
    .filter((x) => x.startsWith("data:"))
    .map((x) => JSON.parse(x.slice(5)));
  const cState = { signatureNamespace: namespace, provider: "agy-enterprise" };
  const oState = {
    signatureNamespace: namespace,
    provider: "agy-enterprise",
    toolCalls: new Map(),
    functionIndex: 0,
  };
  const cEvents = events.flatMap((e) => geminiToClaudeResponse(e, cState) || []);
  const oEvents = events.flatMap((e) => geminiToOpenAIResponse(e, oState) || []);
  const buffered = parseSSEToGeminiResponse(raw, model);
  results.streams[i] = {
    claudeStop: cEvents.find((x) => x.type === "message_delta")?.delta.stop_reason,
    claudeUsage: cState.usage,
    openaiFinish: oEvents.flatMap((x) => x.choices || []).find((x) => x.finish_reason)
      ?.finish_reason,
    openaiUsage: oState.usage,
    bufferedUsage: buffered?.usage,
    bufferedHasReasoning: !!buffered?.choices?.[0]?.message?.reasoning_content,
    bufferedToolCalls: buffered?.choices?.[0]?.message?.tool_calls?.length || 0,
    textOnlyTailSignaturePending:
      !events.some((e) => e.candidates?.[0]?.content?.parts?.some((p) => p.functionCall)) &&
      !!cState.pendingThoughtSignature,
  };
}
fs.writeFileSync(`${dir}/translator-probe.json`, JSON.stringify(results, null, 2) + "\n");
console.log(JSON.stringify(results, null, 2));
process.exit(0);
