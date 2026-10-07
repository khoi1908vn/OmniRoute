// Pure, stateless helper: build a Map<toolName, parametersSchema> from a request body's
// `tools[]` (Chat Completions `{type:"function",function:{name,parameters}}` shape or
// Responses API `{type:"function",name,parameters}` shape). Used to thread each tool's
// JSON Schema into response-side normalization (#6951 — stripEmptyOptionalToolArgs) so
// it can be schema-aware instead of allowlist-only. No stream state, no host import.

import { sanitizeGeminiToolName } from "../../helpers/geminiToolsSanitizer.ts";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

export function extractToolSchemaMap(body: unknown): Map<string, JsonRecord> | null {
  const record = asRecord(body);
  const tools = record?.tools;
  if (!Array.isArray(tools)) return null;

  const map = new Map<string, JsonRecord>();
  for (const tool of tools.flatMap((tool) => {
    const item = asRecord(tool);
    return Array.isArray(item?.functionDeclarations) ? item.functionDeclarations : [tool];
  })) {
    const item = asRecord(tool);
    if (!item) continue;
    const fn = asRecord(item.function);
    const name = (
      typeof fn?.name === "string" ? fn.name : typeof item.name === "string" ? item.name : ""
    ).trim();
    if (!name) continue;
    const schema = asRecord(fn?.parameters ?? item.parameters ?? item.input_schema);
    if (schema) map.set(name, schema);
  }
  return map.size > 0 ? map : null;
}

/** Snapshot original client schemas before provider cleaning removes defaults. */
export function extractEnterpriseReplaySchemas(
  body: unknown,
  toolNameMap?: Map<string, string> | null
): Map<string, JsonRecord> | undefined {
  const tools = asRecord(body)?.tools;
  if (!Array.isArray(tools)) return undefined;
  const map = new Map<string, JsonRecord>();
  const seen = new Set<string>();
  const aliases = new Map(toolNameMap ?? []);
  for (const tool of tools.flatMap((tool) => {
    const item = asRecord(tool);
    return Array.isArray(item?.functionDeclarations) ? item.functionDeclarations : [tool];
  })) {
    const item = asRecord(tool);
    const fn = asRecord(item?.function) ?? item;
    if (!fn || typeof fn.name !== "string" || !fn.name.trim()) continue;
    const nativeName = sanitizeGeminiToolName(fn.name, { toolNameMap: aliases });
    const key = nativeName.toLowerCase();
    if (seen.has(key)) {
      // Even equal-looking duplicates are not an unambiguous issuance contract.
      for (const name of map.keys()) if (name.toLowerCase() === key) map.delete(name);
      continue;
    }
    seen.add(key);
    const schema = asRecord(fn.parameters ?? fn.input_schema);
    if (schema) map.set(nativeName, structuredClone(schema));
  }
  return map.size ? map : undefined;
}
