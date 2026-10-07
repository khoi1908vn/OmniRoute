// Local, privacy-preserving analysis of an explicitly supplied private capture.
import "../../tests/_setup/isolateDataDir.ts";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { claudeToOpenAIRequest } from "../../open-sse/translator/request/claude-to-openai.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import {
  agyEnterpriseReplayHistoryDigest,
  buildAgyEnterpriseReplayNamespace,
} from "../../open-sse/services/geminiThoughtSignatureStore.ts";

const input = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const db = getDbInstance();
for (const row of input.entries)
  db.prepare("INSERT OR REPLACE INTO key_value(namespace,key,value) VALUES(?,?,?)").run(
    "gemini_thought_signatures",
    row.key,
    row.value
  );
const model = input.body.model.replace(/^agy-enterprise\//, "");
const credentials = { _provider: "agy-enterprise", _signatureNamespace: input.connection };
const namespace = buildAgyEnterpriseReplayNamespace(input.connection, model);
for (let count = 1; count <= input.body.messages.length; count++) {
  try {
    const native = claudeToGeminiRequest(
      model,
      { ...input.body, messages: input.body.messages.slice(0, count) },
      false,
      credentials
    );
    console.log("PREFIX", count, agyEnterpriseReplayHistoryDigest(native.contents));
    if (count <= 2) {
      const pivot = claudeToOpenAIRequest(
        model,
        { ...input.body, messages: input.body.messages.slice(0, count) },
        false,
        credentials
      );
      const hub = openaiToGeminiRequest(model, pivot, false, credentials);
      console.log(
        "HUB",
        count,
        agyEnterpriseReplayHistoryDigest(hub.contents),
        hub.contents.length
      );
    }
  } catch (error) {
    console.log("FAIL", count, (error as Error).message);
    const message = input.body.messages[count - 1];
    for (const part of message.content || []) {
      const identity = part.type === "tool_use" ? part.id : part.type === "text" ? part.text : null;
      if (!identity) continue;
      const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
      const rows = input.entries.filter(
        (row: { key: string }) =>
          row.key.startsWith(namespace + ":") && row.key.endsWith(":" + digest)
      );
      console.log(
        "LOOKUP",
        part.type,
        part.id || "text",
        rows.map((row: { key: string; value: string }) => ({
          history: row.key.slice(namespace.length + 1).split(":")[1],
          record: JSON.parse(row.value).signature.startsWith("{")
            ? Object.keys(JSON.parse(JSON.parse(row.value).signature))
            : "signed",
        }))
      );
    }
  }
}
resetDbInstance();
process.exit();
