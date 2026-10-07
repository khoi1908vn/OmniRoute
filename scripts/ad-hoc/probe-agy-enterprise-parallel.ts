import fs from "node:fs";
import { getProviderConnectionById } from "../../src/lib/db/providers.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { AgyEnterpriseExecutor } from "../../open-sse/executors/agyEnterprise.ts";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const connection = await getProviderConnectionById(input.connection);
const executor = new AgyEnterpriseExecutor();
const model = "gemini-3.8-flash-low";
const body = {
  contents: [
    {
      role: "user",
      parts: [
        {
          text: "Call lookup exactly three times in parallel for index 1, 2, and 3. Do not answer until you have the three results.",
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "lookup",
          description: "Look up a synthetic file index",
          parameters: {
            type: "OBJECT",
            properties: { index: { type: "INTEGER" } },
            required: ["index"],
          },
        },
      ],
    },
  ],
  generationConfig: { maxOutputTokens: 1024 },
};
const native = executor.transformRequest(model, body, true, connection);
const rebuiltHistory = process.argv.includes("--rebuilt-history");
if (rebuiltHistory) {
  native.contents[0].parts.push({ text: "Synthetic initial teammate reminder." });
  native.contents.push({ role: "user", parts: [{ text: "Synthetic initial hook context." }] });
}
const dispatch = async (payload: unknown) => {
  const response = await fetch(executor.buildUrl(model, true, 0, connection), {
    method: "POST",
    headers: executor.buildHeaders(connection),
    body: JSON.stringify(payload),
  });
  const wire = await response.text();
  const parts: Array<Record<string, unknown>> = [];
  for (const line of wire.split(/\r?\n/))
    if (line.startsWith("data: ")) {
      const event = JSON.parse(line.slice(6));
      parts.push(...(event.candidates?.[0]?.content?.parts || []));
    }
  console.log(
    "NATIVE",
    response.status,
    parts.map((p) => ({
      type: p.functionCall ? "call" : p.thought ? "thought" : "text",
      signed: typeof p.thoughtSignature === "string",
      call: p.functionCall ? (p.functionCall as { id: string }).id : undefined,
      chars: typeof p.text === "string" ? p.text.length : undefined,
    }))
  );
  return { response, parts };
};
const initial = await dispatch(native);
const calls = initial.parts.filter((p) => p.functionCall);
if (calls.length > 1 && initial.response.ok) {
  const replay = initial.parts.filter((p) => !p.thought && (p.functionCall || p.text));
  await dispatch({
    ...native,
    contents: [
      ...(rebuiltHistory ? body.contents : native.contents),
      { role: "model", parts: replay },
      {
        role: "model",
        parts: calls.map((p) => ({
          functionResponse: {
            id: (p.functionCall as { id: string }).id,
            name: "lookup",
            response: { output: "synthetic file found" },
          },
        })),
      },
    ],
  });
}
resetDbInstance();
process.exit();
