import { createHash } from "crypto";

import { cleanJSONSchemaForAntigravity } from "./geminiHelper.ts";
import { agyEnterpriseWebSearchSchema } from "../../utils/agyEnterprise.ts";

type GeminiFunctionDeclaration = {
  name: string;
  description: string;
  parameters: unknown;
};

type GeminiTool = {
  functionDeclarations?: GeminiFunctionDeclaration[];
  googleSearch?: Record<string, unknown>;
  enterpriseWebSearch?: Record<string, unknown>;
};

type GeminiToolSanitizationOptions = {
  stripNamespace?: boolean;
  toolNameMap?: Map<string, string> | null;
  agyEnterprise?: boolean;
};

const MAX_GEMINI_TOOL_NAME_LENGTH = 64;
const GEMINI_TOOL_HASH_LENGTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Gemini/Vertex requires every functionDeclaration.parameters to be an OBJECT-typed schema
 * (#3357: "functionDeclaration parameters schema should be of type OBJECT"). Some clients
 * (e.g. GitHub Copilot's `terminal_last_command`) send a `parameters` that is present but
 * lacks a top-level `type: "object"` — just `{ properties }`, a scalar/array type, or `{}`.
 * Coerce the parameters root to an object schema before it is cleaned; a falsy/non-record
 * schema becomes an empty object schema. Only the top level is touched — nested property
 * schemas are left to cleanJSONSchemaForAntigravity.
 */
function toGeminiParametersSchema(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) {
    return { type: "object", properties: {} };
  }
  if (raw.type === "object") {
    return raw;
  }
  return {
    ...raw,
    type: "object",
    properties: isRecord(raw.properties) ? raw.properties : {},
  };
}

function normalizeGeminiToolName(
  name: string,
  options: GeminiToolSanitizationOptions = {}
): string {
  const trimmed = name.trim();
  const namespaceStripped = !options.stripNamespace
    ? trimmed
    : (() => {
        const namespaceIndex = trimmed.indexOf(":");
        return namespaceIndex >= 0 ? trimmed.slice(namespaceIndex + 1) : trimmed;
      })();

  return (
    namespaceStripped
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      // Google rejects the WHOLE GenerateContentRequest when any one
      // functionDeclaration name fails its grammar, and that grammar requires a
      // letter or an underscore first. The strip above has just removed any
      // leading underscore, so a name like `1c_plugin_reload` reached Google
      // unchanged and took the other 108 tools down with it (#13715). Prefixing
      // here rather than at the call site keeps the guarantee on the one value
      // every path reads: the length cap and the collision hash both build on
      // this string, and a hashed name inherits its first character from it.
      .replace(/^(\d)/, "t$1")
  );
}

function buildHashedGeminiToolName(
  baseName: string,
  originalName: string,
  hashLength: number
): string {
  const effectiveBase = baseName || "tool";
  const hash = createHash("sha256").update(originalName).digest("hex").slice(0, hashLength);
  const prefixLength = Math.max(1, MAX_GEMINI_TOOL_NAME_LENGTH - 1 - hash.length);
  return `${effectiveBase.slice(0, prefixLength)}_${hash}`;
}

function findSanitizedNameForOriginal(
  toolNameMap: Map<string, string> | null | undefined,
  originalName: string
): string | null {
  if (!(toolNameMap instanceof Map)) return null;
  for (const [sanitizedName, rawName] of toolNameMap.entries()) {
    if (rawName === originalName) {
      return sanitizedName;
    }
  }
  return null;
}

function isSanitizedNameTaken(
  toolNameMap: Map<string, string> | null | undefined,
  sanitizedName: string,
  originalName: string
): boolean {
  if (!(toolNameMap instanceof Map)) return false;
  const mappedOriginalName = toolNameMap.get(sanitizedName);
  return typeof mappedOriginalName === "string" && mappedOriginalName !== originalName;
}

export function sanitizeGeminiToolName(
  name: string,
  options: GeminiToolSanitizationOptions = {}
): string {
  const normalizedName = normalizeGeminiToolName(name, options) || "tool";
  const toolNameMap = options.toolNameMap instanceof Map ? options.toolNameMap : null;
  const existingSanitizedName = findSanitizedNameForOriginal(toolNameMap, name);
  if (existingSanitizedName) {
    return existingSanitizedName;
  }

  let sanitizedName =
    normalizedName.length <= MAX_GEMINI_TOOL_NAME_LENGTH
      ? normalizedName
      : buildHashedGeminiToolName(normalizedName, name, GEMINI_TOOL_HASH_LENGTH);

  if (isSanitizedNameTaken(toolNameMap, sanitizedName, name)) {
    const conflictingOriginalName = toolNameMap?.get(sanitizedName);
    sanitizedName = buildHashedGeminiToolName(normalizedName, name, GEMINI_TOOL_HASH_LENGTH);
    let hashLength = GEMINI_TOOL_HASH_LENGTH + 2;
    while (isSanitizedNameTaken(toolNameMap, sanitizedName, name) && hashLength <= 32) {
      sanitizedName = buildHashedGeminiToolName(normalizedName, name, hashLength);
      hashLength += 2;
    }

    if (isSanitizedNameTaken(toolNameMap, sanitizedName, name)) {
      sanitizedName = buildHashedGeminiToolName("tool", `${name}:${Date.now()}`, 12);
    }

    console.warn(
      `[GeminiTools] Tool name collision after sanitization: "${name}" conflicts with "${conflictingOriginalName}". Using "${sanitizedName}".`
    );
  }

  toolNameMap?.set(sanitizedName, name);
  return sanitizedName;
}

function toEnterpriseSearchTool(tool: Record<string, unknown>): GeminiTool | null {
  const fn = isRecord(tool.function) ? tool.function : null;
  const name = fn?.name ?? tool.name;
  const type = typeof tool.type === "string" ? tool.type : "";
  const isSearch =
    "enterpriseWebSearch" in tool ||
    "googleSearch" in tool ||
    "google_search" in tool ||
    /^(?:web_search(?:_preview)?(?:_\d{8})?|googleSearch|google_search)$/.test(type) ||
    name === "WebSearch" ||
    (tool.type === "function" && (name === "googleSearch" || name === "google_search"));
  if (!isSearch) return null;

  const unsupported = [
    "allowed_domains",
    "max_uses",
    "user_location",
    "filters",
    "search_context_size",
    "external_web_access",
  ];
  if (unsupported.some((field) => tool[field] !== undefined)) {
    throw Object.assign(
      new Error(
        "Enterprise native search does not support allowlists, search limits or localization"
      ),
      {
        statusCode: 400,
        errorType: "invalid_request_error",
      }
    );
  }
  // Dynamic filtering would require Claude's code execution, not native Gemini search.
  if (
    tool.allowed_callers !== undefined &&
    (!Array.isArray(tool.allowed_callers) ||
      tool.allowed_callers.length !== 1 ||
      tool.allowed_callers[0] !== "direct")
  ) {
    throw Object.assign(new Error("Enterprise native search supports only direct callers"), {
      statusCode: 400,
      errorType: "invalid_request_error",
    });
  }
  const native =
    "enterpriseWebSearch" in tool
      ? tool.enterpriseWebSearch
      : "googleSearch" in tool
        ? tool.googleSearch
        : "google_search" in tool
          ? tool.google_search
          : {};
  const parsed = agyEnterpriseWebSearchSchema.safeParse(native);
  const blocked = agyEnterpriseWebSearchSchema.safeParse(
    tool.blocked_domains !== undefined ? { excludeDomains: tool.blocked_domains } : {}
  );
  if (!parsed.success || !blocked.success) {
    throw Object.assign(
      new Error(
        "Invalid Enterprise native search options: only hostname excludeDomains are supported"
      ),
      {
        statusCode: 400,
        errorType: "invalid_request_error",
      }
    );
  }
  const excludeDomains = [
    ...new Set([...(parsed.data.excludeDomains || []), ...(blocked.data.excludeDomains || [])]),
  ];
  return { enterpriseWebSearch: excludeDomains.length ? { excludeDomains } : {} };
}

function toGeminiGoogleSearchTool(tool: Record<string, unknown>): GeminiTool | null {
  if (isRecord(tool.googleSearch)) {
    return { googleSearch: tool.googleSearch };
  }
  if (tool.googleSearch !== undefined) {
    return { googleSearch: {} };
  }

  if (isRecord(tool.google_search)) {
    return { googleSearch: tool.google_search };
  }
  if (tool.google_search !== undefined) {
    return { googleSearch: {} };
  }

  const toolType = typeof tool.type === "string" ? tool.type : "";
  if (
    toolType === "googleSearch" ||
    toolType === "google_search" ||
    toolType === "web_search" ||
    toolType === "web_search_preview"
  ) {
    return { googleSearch: {} };
  }

  return null;
}

export function buildGeminiTools(
  tools: unknown,
  options: GeminiToolSanitizationOptions = {}
): GeminiTool[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined;
  }

  const functionDeclarations: GeminiFunctionDeclaration[] = [];
  // Track sanitized names already added to prevent Gemini rejection from duplicate
  // function declaration names (two different raw names that collapse to the same
  // sanitized form, or the same raw name repeated across tool groups).
  const seenToolNames = new Set<string>();
  let googleSearchTool: GeminiTool | null = null;

  for (const rawTool of tools) {
    if (!isRecord(rawTool)) {
      continue;
    }

    const normalizedGoogleSearchTool = options.agyEnterprise
      ? toEnterpriseSearchTool(rawTool)
      : toGeminiGoogleSearchTool(rawTool);
    if (normalizedGoogleSearchTool) {
      if (options.agyEnterprise && googleSearchTool) {
        const previous = googleSearchTool.enterpriseWebSearch?.excludeDomains as
          string[] | undefined;
        const current = normalizedGoogleSearchTool.enterpriseWebSearch?.excludeDomains as
          string[] | undefined;
        const excludeDomains = [...new Set([...(previous || []), ...(current || [])])];
        googleSearchTool = { enterpriseWebSearch: excludeDomains.length ? { excludeDomains } : {} };
      } else {
        googleSearchTool = normalizedGoogleSearchTool;
      }
      if (!options.agyEnterprise || !Array.isArray(rawTool.functionDeclarations)) continue;
    }

    if (Array.isArray(rawTool.functionDeclarations)) {
      for (const fn of rawTool.functionDeclarations) {
        if (!isRecord(fn) || typeof fn.name !== "string" || !fn.name.trim()) {
          continue;
        }

        const sanitizedName = sanitizeGeminiToolName(fn.name, options);
        if (seenToolNames.has(sanitizedName)) continue;
        seenToolNames.add(sanitizedName);
        functionDeclarations.push({
          name: sanitizedName,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: cleanJSONSchemaForAntigravity(toGeminiParametersSchema(fn.parameters)),
        });
      }
      continue;
    }

    if (typeof rawTool.name === "string" && rawTool.name.trim()) {
      const sanitizedName = sanitizeGeminiToolName(rawTool.name, options);
      if (!seenToolNames.has(sanitizedName)) {
        seenToolNames.add(sanitizedName);
        functionDeclarations.push({
          name: sanitizedName,
          description: typeof rawTool.description === "string" ? rawTool.description : "",
          parameters: cleanJSONSchemaForAntigravity(toGeminiParametersSchema(rawTool.input_schema)),
        });
      }
      continue;
    }

    if (rawTool.type === "function" && isRecord(rawTool.function)) {
      const fn = rawTool.function;
      if (typeof fn.name !== "string" || !fn.name.trim()) {
        continue;
      }

      const sanitizedName = sanitizeGeminiToolName(fn.name, options);
      if (!seenToolNames.has(sanitizedName)) {
        seenToolNames.add(sanitizedName);
        functionDeclarations.push({
          name: sanitizedName,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: cleanJSONSchemaForAntigravity(toGeminiParametersSchema(fn.parameters)),
        });
      }
    }
  }

  const result: GeminiTool[] = [];

  if (googleSearchTool) {
    if (!options.agyEnterprise) return [googleSearchTool];
    result.push(googleSearchTool);
  }

  if (functionDeclarations.length > 0) {
    result.push({ functionDeclarations });
  }

  return result.length > 0 ? result : undefined;
}
