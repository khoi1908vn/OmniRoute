import { createHash } from "node:crypto";
import { z } from "zod";
import { getDbInstance } from "../../src/lib/db/core.ts";

const MAX_SIGNATURES = 1000;
const MAX_PERSISTED_SIGNATURES = 2_000;
const MEMORY_TTL_MS = 1000 * 60 * 60;
const PERSISTED_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const NAMESPACE = "gemini_thought_signatures";

export type SignatureCacheMode = "enabled" | "bypass" | "bypass-strict";

type Entry = {
  signature: string;
  expiresAt: number;
};

type PersistedEntry = Entry & {
  createdAt: number;
};

const signatures = new Map<string, Entry>();
const AMBIGUOUS_TEXT = "!ambiguous-enterprise-text!";

export function buildAgyEnterpriseReplayNamespace(
  connectionId: string,
  experience: string
): string {
  if (!connectionId || !experience)
    throw new Error("Enterprise replay requires connection and experience");
  return `agy-enterprise:${JSON.stringify([connectionId, experience])}`;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

export function agyEnterpriseReplayHistoryDigest(contents: unknown = []): string {
  const history = Array.isArray(contents)
    ? contents.map((content) => {
        const entry = content as { role: string; parts: Array<Record<string, unknown>> };
        return {
          role: entry.role,
          parts: entry.parts
            .filter((part) => !part.thought)
            .map(({ thoughtSignature: _signature, ...part }) => part),
        };
      })
    : [];
  return createHash("sha256")
    .update(JSON.stringify(canonical(history)))
    .digest("hex");
}

function enterpriseReplayKey(
  namespace: string,
  kind: string,
  identity: unknown,
  history: unknown
): string {
  return enterpriseReplayKeyForDigest(
    namespace,
    kind,
    identity,
    agyEnterpriseReplayHistoryDigest(history)
  );
}

function enterpriseReplayKeyForDigest(
  namespace: string,
  kind: string,
  identity: unknown,
  historyDigest: string
): string {
  return `${namespace}:${kind}:${historyDigest}:${createHash("sha256")
    .update(JSON.stringify(canonical(identity)))
    .digest("hex")}`;
}

type EnterpriseReplayRow = { key: string; value: string };
function readEnterpriseRow(key: string): EnterpriseReplayRow | undefined {
  return getDbInstance()
    .prepare("SELECT key, value FROM key_value WHERE namespace = ? AND key = ?")
    .get(NAMESPACE, key) as EnterpriseReplayRow | undefined;
}

function findEnterpriseCallOrigins(namespace: string, id: string): EnterpriseReplayRow[] {
  const prefix = `${namespace}:call:`;
  const suffix = `:${createHash("sha256").update(JSON.stringify(id)).digest("hex")}`;
  return getDbInstance()
    .prepare(
      "SELECT key, value FROM key_value WHERE namespace = ? AND substr(key, 1, ?) = ? AND substr(key, -?) = ?"
    )
    .all(NAMESPACE, prefix.length, prefix, suffix.length, suffix) as EnterpriseReplayRow[];
}

function resolveEnterpriseCallRecord(
  namespace: string,
  id: string,
  history: unknown
): { value: string; historyDigest: string } | null {
  try {
    const exact = readEnterpriseRow(enterpriseReplayKey(namespace, "call", id, history));
    // A teammate wakeup may rebuild hook context. The native call remains immutable;
    // resolve its original turn only when the scoped ID has one recorded origin.
    const origins = exact ? [exact] : findEnterpriseCallOrigins(namespace, id);
    if (origins.length !== 1) return null;
    const entry = parsePersistedEntry(origins[0].value);
    if (!entry || entry.entry.signature === AMBIGUOUS_TEXT) return null;
    return {
      value: entry.entry.signature,
      historyDigest: origins[0].key.slice(`${namespace}:call:`.length).split(":")[0],
    };
  } catch (error) {
    warnPersistenceError("enterprise-read", error);
    return null;
  }
}

// Enterprise reads SQLite on every lookup: another process's conflict must be
// authoritative over this process's memory cache. Conflicts are written atomically.
function readEnterpriseSignature(key: string): string | null {
  try {
    const row = readEnterpriseRow(key);
    const entry = row && parsePersistedEntry(row.value);
    return entry && entry.entry.signature !== AMBIGUOUS_TEXT ? entry.entry.signature : null;
  } catch (error) {
    warnPersistenceError("enterprise-read", error);
    return null;
  }
}

function storeEnterpriseSignature(key: string, signature: string): void {
  if (!signature) return;
  try {
    const db = getDbInstance();
    db.immediate(() => {
      const row = db
        .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
        .get(NAMESPACE, key) as { value: string } | undefined;
      const previous = row && parsePersistedEntry(row.value);
      // A retained expired identity cannot be associated with a newer signature.
      const conflict = row && (!previous || previous.entry.signature !== signature);
      const now = Date.now();
      db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
        NAMESPACE,
        key,
        serializePersistedEntry({
          signature: conflict ? AMBIGUOUS_TEXT : signature,
          createdAt: now,
          expiresAt: now + PERSISTED_TTL_MS,
        })
      );
    });
    maybePrunePersistedSignatures(db);
  } catch (error) {
    warnPersistenceError("enterprise-store", error);
  }
}

export function storeAgyEnterpriseTextSignature(
  namespace: string,
  text: string,
  signature: string,
  history: unknown = []
): void {
  if (!namespace?.startsWith("agy-enterprise:") || !text) return;
  storeEnterpriseSignature(enterpriseReplayKey(namespace, "text", text, history), signature);
}

export function getAgyEnterpriseTextSignature(
  namespace: string,
  text: string,
  history: unknown = []
): string | null {
  if (!namespace?.startsWith("agy-enterprise:") || !text) return null;
  const replay = getAgyEnterpriseTextReplay(namespace, text, [], history);
  return replay?.thoughtSignature || null;
}

export type EnterpriseCall = { id: string; name: string; args?: unknown };
export type EnterpriseNativeCallPart = {
  functionCall: EnterpriseCall;
  thoughtSignature?: string;
};
type OptionalDefaults = Record<string, string | number | boolean>;
type CallReplay = {
  thoughtSignature?: string;
  nativePart: EnterpriseNativeCallPart;
  match: "exact" | "optional_default_inserted";
};
export type EnterpriseReplayFailureReason =
  | "missing"
  | "expired"
  | "invalid_record"
  | "conflicting_capture"
  | "ambiguous_origin"
  | "argument_mismatch"
  | "group_mismatch"
  | "store_unavailable"
  | "legacy_schema_unavailable";
export type EnterpriseCallReplayResolution =
  | { ok: true; replay: CallReplay }
  | {
      ok: false;
      reason: EnterpriseReplayFailureReason;
      originRecords: number;
      difference?: "added" | "removed" | "changed" | "type";
    };

const nativeCallPartSchema = z
  .object({
    functionCall: z
      .object({ id: z.string().min(1), name: z.string().min(1), args: z.unknown().optional() })
      .passthrough(),
    thoughtSignature: z.string().min(1).optional(),
  })
  .passthrough();
const legacyCallRecordSchema = z.object({
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(1).optional(),
  kind: z.literal("native-unsigned-call").optional(),
  callsDigest: z.string().optional(),
});
const nativeCallRecordSchema = legacyCallRecordSchema.extend({
  version: z.literal(2),
  nativePart: nativeCallPartSchema,
  optionalDefaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  groupIds: z.array(z.string().min(1)).min(1),
});
type CallRecord = z.infer<typeof legacyCallRecordSchema> &
  Partial<z.infer<typeof nativeCallRecordSchema>>;

function hashCall(call: EnterpriseCall): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(enterpriseCallIdentity(call))))
    .digest("hex");
}

function recordObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalDefaults(schema: Record<string, unknown> | undefined): OptionalDefaults {
  const defaults: OptionalDefaults = {};
  // This bridge supports plain properties plus annotations, not general schema
  // evaluation. Constraints can make a typed default invalid or conditionally required.
  const objectKeywords = new Set([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "description",
    "title",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "$comment",
    "$schema",
    "$id",
  ]);
  const propertyKeywords = new Set([
    "type",
    "default",
    "description",
    "title",
    "examples",
    "deprecated",
    "readOnly",
    "writeOnly",
    "$comment",
  ]);
  if (
    !schema ||
    schema.type !== "object" ||
    Object.keys(schema).some((key) => !objectKeywords.has(key)) ||
    (schema.required !== undefined &&
      (!Array.isArray(schema.required) || schema.required.some((name) => typeof name !== "string")))
  )
    return defaults;
  const properties = recordObject(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (!properties) return defaults;
  for (const [name, value] of Object.entries(properties)) {
    const property = recordObject(value);
    if (
      !property ||
      required.includes(name) ||
      Object.keys(property).some((key) => !propertyKeywords.has(key))
    )
      continue;
    const fallback = property.default;
    const type = property.type;
    if (
      (type === "boolean" && typeof fallback === "boolean") ||
      (type === "string" && typeof fallback === "string") ||
      ((type === "number" || type === "integer") &&
        typeof fallback === "number" &&
        Number.isFinite(fallback) &&
        (type !== "integer" || Number.isInteger(fallback)))
    ) {
      Object.defineProperty(defaults, name, {
        value: fallback,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return defaults;
}

function matchCall(entry: CallRecord, call: EnterpriseCall): CallReplay | null {
  const exact = entry.identity === hashCall(call);
  if (!exact) {
    if (entry.version !== 2 || !entry.nativePart || !entry.optionalDefaults) return null;
    const original = recordObject(entry.nativePart.functionCall.args ?? {});
    const incoming = recordObject(call.args ?? {});
    if (!original || !incoming) return null;
    const candidate = { ...incoming };
    for (const key of Object.keys(incoming)) {
      if (Object.hasOwn(original, key)) continue;
      if (
        !Object.hasOwn(entry.optionalDefaults, key) ||
        incoming[key] !== entry.optionalDefaults[key]
      )
        return null;
      delete candidate[key];
    }
    if (hashCall({ ...call, args: candidate }) !== entry.identity) return null;
  }
  return {
    ...(entry.signature ? { thoughtSignature: entry.signature } : {}),
    nativePart: structuredClone(
      entry.nativePart ?? {
        functionCall: call,
        ...(entry.signature ? { thoughtSignature: entry.signature } : {}),
      }
    ),
    match: exact ? "exact" : "optional_default_inserted",
  };
}

function argumentDifference(
  entry: CallRecord,
  call: EnterpriseCall
): "added" | "removed" | "changed" | "type" {
  const original = recordObject(entry.nativePart?.functionCall.args ?? {});
  const incoming = recordObject(call.args ?? {});
  if (!original || !incoming) return "type";
  if (Object.keys(original).some((key) => !Object.hasOwn(incoming, key))) return "removed";
  if (Object.keys(incoming).some((key) => !Object.hasOwn(original, key))) return "added";
  if (Object.keys(original).some((key) => typeof original[key] !== typeof incoming[key]))
    return "type";
  return "changed";
}

function loadCallRecord(
  namespace: string,
  id: string,
  history: unknown
):
  | { ok: true; entry: CallRecord; historyDigest: string }
  | { ok: false; reason: EnterpriseReplayFailureReason; originRecords: number } {
  const exact = readEnterpriseRow(enterpriseReplayKey(namespace, "call", id, history));
  const origins = exact ? [exact] : findEnterpriseCallOrigins(namespace, id);
  const fail = (reason: EnterpriseReplayFailureReason) => ({
    ok: false as const,
    reason,
    originRecords: origins.length,
  });
  if (!origins.length) return fail("missing");
  if (origins.length !== 1) return fail("ambiguous_origin");
  let envelope: Record<string, unknown> | null;
  try {
    envelope = recordObject(JSON.parse(origins[0].value));
  } catch {
    return fail("invalid_record");
  }
  if (!envelope || typeof envelope.expiresAt !== "number" || typeof envelope.signature !== "string")
    return fail("invalid_record");
  if (envelope.expiresAt <= Date.now()) return fail("expired");
  if (envelope.signature === AMBIGUOUS_TEXT) return fail("conflicting_capture");
  let raw: Record<string, unknown> | null;
  try {
    raw = recordObject(JSON.parse(envelope.signature));
  } catch {
    return fail("invalid_record");
  }
  if (!raw || ("version" in raw && raw.version !== 2)) return fail("invalid_record");
  const parsed = (raw.version === 2 ? nativeCallRecordSchema : legacyCallRecordSchema).safeParse(
    raw
  );
  if (!parsed.success) return fail("invalid_record");
  const entry: CallRecord = parsed.data;
  if (
    entry.version === 2 &&
    (!entry.nativePart ||
      hashCall(entry.nativePart.functionCall) !== entry.identity ||
      entry.nativePart.functionCall.id !== id ||
      entry.nativePart.thoughtSignature !== entry.signature ||
      !entry.groupIds?.includes(id) ||
      new Set(entry.groupIds).size !== entry.groupIds.length)
  )
    return fail("invalid_record");
  if (!entry.signature && (entry.kind !== "native-unsigned-call" || !entry.callsDigest))
    return fail("invalid_record");
  return {
    ok: true,
    entry,
    historyDigest: origins[0].key.slice(`${namespace}:call:`.length).split(":")[0],
  };
}
function enterpriseCallIdentity(call: EnterpriseCall): unknown {
  return { id: call.id, name: call.name.toLowerCase(), args: call.args ?? {} };
}
function enterpriseCallsDigest(calls: EnterpriseCall[]): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(calls.map(enterpriseCallIdentity))))
    .digest("hex");
}

export function getAgyEnterpriseTextReplay(
  namespace: string,
  text: string,
  calls: EnterpriseCall[],
  history: unknown = []
): { thoughtSignature?: string } | null {
  if (!namespace?.startsWith("agy-enterprise:") || !text) return null;
  const key = enterpriseReplayKey(namespace, "text", text, history);
  let value = readEnterpriseSignature(key);
  if (!value && calls.length) {
    try {
      // Existing expired/conflicting text is authoritative, never bypass it.
      if (readEnterpriseRow(key)) return null;
      const origins = calls.map((call) => resolveEnterpriseCallRecord(namespace, call.id, history));
      const origin = origins[0];
      if (
        !origin ||
        origins.some((entry) => !entry || entry.historyDigest !== origin.historyDigest)
      )
        return null;
      if (calls.some((call) => !getAgyEnterpriseCallReplay(namespace, call, calls, history)))
        return null;
      value = readEnterpriseSignature(
        enterpriseReplayKeyForDigest(namespace, "text", text, origin.historyDigest)
      );
    } catch {
      return null;
    }
  }
  if (!value) return null;
  if (!value.startsWith("{")) return { thoughtSignature: value };
  try {
    const record = JSON.parse(value) as { kind: string; callsDigest: string };
    return record.kind === "native-unsigned-precall-text" &&
      calls.length &&
      record.callsDigest ===
        enterpriseCallsDigest(
          calls.map(
            (call) =>
              getAgyEnterpriseCallReplay(namespace, call, calls, history)?.nativePart
                .functionCall ?? call
          )
        ) &&
      calls.every((call) => getAgyEnterpriseCallReplay(namespace, call, calls, history))
      ? {}
      : null;
  } catch {
    return null;
  }
}

export function storeAgyEnterpriseCallSignature(
  namespace: string,
  call: EnterpriseCall,
  signature: string,
  history: unknown = []
): void {
  if (!namespace?.startsWith("agy-enterprise:") || !call.id || !call.name) return;
  // ID plus history locates the turn; bind the contents in the stored value so
  // altered arguments and conflicting ID reuse fail rather than finding a new key.
  const identity = createHash("sha256")
    .update(JSON.stringify(canonical(enterpriseCallIdentity(call))))
    .digest("hex");
  storeEnterpriseSignature(
    enterpriseReplayKey(namespace, "call", call.id, history),
    JSON.stringify({ identity, signature })
  );
}
export function getAgyEnterpriseCallSignature(
  namespace: string,
  call: EnterpriseCall,
  history: unknown = []
): string | null {
  return getAgyEnterpriseCallReplay(namespace, call, [], history)?.thoughtSignature || null;
}

export function getAgyEnterpriseCallReplay(
  namespace: string,
  call: EnterpriseCall,
  calls: EnterpriseCall[],
  history: unknown = []
): CallReplay | null {
  const result = resolveAgyEnterpriseCallReplay(namespace, call, calls, history);
  return result.ok ? result.replay : null;
}

export function resolveAgyEnterpriseCallReplay(
  namespace: string,
  call: EnterpriseCall,
  calls: EnterpriseCall[],
  history: unknown = []
): EnterpriseCallReplayResolution {
  const fail = (reason: EnterpriseReplayFailureReason, originRecords = 1) => ({
    ok: false as const,
    reason,
    originRecords,
  });
  if (!namespace?.startsWith("agy-enterprise:") || !call.id || !call.name)
    return fail("invalid_record", 0);
  try {
    const loaded = loadCallRecord(namespace, call.id, history);
    if (!loaded.ok) return loaded;
    const { entry, historyDigest } = loaded;
    const replay = matchCall(entry, call);
    if (!replay)
      return {
        ...fail(entry.version === 2 ? "argument_mismatch" : "legacy_schema_unavailable"),
        ...(entry.version === 2 ? { difference: argumentDifference(entry, call) } : {}),
      };
    // Signed single-call lookup remains available for the legacy signature API.
    if (entry.signature && !calls.length) return { ok: true, replay };
    if (
      entry.version === 2 &&
      JSON.stringify(entry.groupIds) !== JSON.stringify(calls.map((c) => c.id))
    )
      return fail("group_mismatch");
    if (entry.signature && entry.version !== 2) return { ok: true, replay };
    const originals: EnterpriseCall[] = [];
    let signedSibling = false;
    for (const sibling of calls) {
      const origin = loadCallRecord(namespace, sibling.id, history);
      if (!origin.ok) return origin;
      if (origin.historyDigest !== historyDigest) return fail("group_mismatch");
      const matched = matchCall(origin.entry, sibling);
      if (!matched)
        return fail(origin.entry.version === 2 ? "argument_mismatch" : "legacy_schema_unavailable");
      originals.push(matched.nativePart.functionCall);
      signedSibling ||= Boolean(origin.entry.signature);
    }
    if (
      !signedSibling ||
      (entry.callsDigest && entry.callsDigest !== enterpriseCallsDigest(originals))
    )
      return fail("group_mismatch");
    return { ok: true, replay };
  } catch {
    return fail("store_unavailable", 0);
  }
}

export function describeAgyEnterpriseReplayFailure(
  namespace: string,
  kind: "call" | "text",
  identity: string,
  history: unknown,
  resolution?: EnterpriseCallReplayResolution
): string {
  const key = enterpriseReplayKey(namespace, kind, identity, history);
  let reason = "missing";
  let originRecords = 0;
  if (resolution && !resolution.ok) {
    reason = resolution.reason;
    originRecords = resolution.originRecords;
  } else
    try {
      const row = getDbInstance()
        .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
        .get(NAMESPACE, key) as { value: string } | undefined;
      if (row) {
        originRecords = 1;
        const entry = parsePersistedEntry(row.value);
        let expired = false;
        try {
          expired = JSON.parse(row.value).expiresAt <= Date.now();
        } catch {
          /* Invalid envelope. */
        }
        reason = !entry
          ? expired
            ? "expired"
            : "invalid_record"
          : entry.entry.signature === AMBIGUOUS_TEXT
            ? "conflicting_capture"
            : "identity_or_group_mismatch";
      } else if (kind === "call") {
        const origins = findEnterpriseCallOrigins(namespace, identity);
        originRecords = origins.length;
        const origin = origins.length === 1 ? parsePersistedEntry(origins[0].value) : null;
        let expired = false;
        try {
          expired = origins.length === 1 && JSON.parse(origins[0].value).expiresAt <= Date.now();
        } catch {
          /* Invalid envelope. */
        }
        reason =
          origins.length > 1
            ? "ambiguous_origin"
            : origins.length === 1
              ? !origin
                ? expired
                  ? "expired"
                  : "invalid_record"
                : origin.entry.signature === AMBIGUOUS_TEXT
                  ? "conflicting_capture"
                  : "identity_or_group_mismatch"
              : "missing";
      }
    } catch {
      reason = "store_unavailable";
    }
  let experience = "unbound";
  try {
    if (namespace?.startsWith("agy-enterprise:"))
      experience = JSON.parse(namespace.slice("agy-enterprise:".length))[1];
  } catch {
    /* Malformed namespace must not replace a replay failure. */
  }
  const safeLabel = (value: string) =>
    typeof value === "string" && /^[a-zA-Z0-9_.-]{1,128}$/.test(value)
      ? value
      : createHash("sha256").update(String(value)).digest("hex");
  const difference =
    resolution && !resolution.ok && resolution.difference
      ? `; difference=${resolution.difference}`
      : "";
  return `kind=${kind}; reason=${reason}${difference}; experience=${safeLabel(experience)}; ${kind === "call" ? `id=${safeLabel(identity)}; originRecords=${originRecords}` : `textChars=${identity.length}`}; history=${agyEnterpriseReplayHistoryDigest(history)}; historyTurns=${Array.isArray(history) ? history.length : 0}`;
}

export type AgyEnterpriseReplayState = {
  provider?: string;
  signatureNamespace?: string | null;
  enterpriseReplayHistory?: unknown;
  enterpriseReplaySchemas?: Map<string, Record<string, unknown>>;
  enterpriseVisibleText?: string;
  enterpriseTextSignature?: string | null;
  enterpriseSignedText?: string;
  enterpriseHasCall?: boolean;
  enterpriseTextAfterCall?: boolean;
  enterpriseCalls?: Array<{
    call: EnterpriseCall;
    signature?: string;
    nativePart: EnterpriseNativeCallPart;
    optionalDefaults: OptionalDefaults;
  }>;
};

// Persist only complete turns. A call's empty signature tail cannot sign prose.
export function captureAgyEnterpriseReplayParts(
  state: AgyEnterpriseReplayState,
  parts: Array<Record<string, unknown>>,
  terminal: boolean
): void {
  if (state.provider !== "agy-enterprise" || !state.signatureNamespace) return;
  for (const part of parts) {
    if (part.functionCall) {
      state.enterpriseHasCall = true;
      state.enterpriseCalls ??= [];
      state.enterpriseCalls.push({
        call: structuredClone(part.functionCall) as EnterpriseCall,
        signature: typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined,
        nativePart: structuredClone(part) as EnterpriseNativeCallPart,
        optionalDefaults: optionalDefaults(
          [...(state.enterpriseReplaySchemas ?? [])].find(
            ([name]) =>
              name.toLowerCase() === (part.functionCall as EnterpriseCall).name.toLowerCase()
          )?.[1]
        ),
      });
    }
    if (part.thought !== true && typeof part.text === "string" && !part.functionCall) {
      if (part.text && state.enterpriseHasCall) state.enterpriseTextAfterCall = true;
      state.enterpriseVisibleText = (state.enterpriseVisibleText || "") + part.text;
      if (typeof part.thoughtSignature === "string" && (part.text || !state.enterpriseHasCall)) {
        state.enterpriseTextSignature = part.thoughtSignature;
        state.enterpriseSignedText = state.enterpriseVisibleText;
      }
    }
  }
  if (!terminal) return;
  if (
    state.enterpriseVisibleText &&
    state.enterpriseTextSignature &&
    state.enterpriseSignedText === state.enterpriseVisibleText
  )
    storeAgyEnterpriseTextSignature(
      state.signatureNamespace,
      state.enterpriseVisibleText,
      state.enterpriseTextSignature,
      state.enterpriseReplayHistory
    );
  if (
    state.enterpriseVisibleText &&
    !state.enterpriseTextSignature &&
    !state.enterpriseTextAfterCall &&
    state.enterpriseCalls?.some((entry) => entry.signature)
  )
    storeEnterpriseSignature(
      enterpriseReplayKey(
        state.signatureNamespace,
        "text",
        state.enterpriseVisibleText,
        state.enterpriseReplayHistory
      ),
      JSON.stringify({
        kind: "native-unsigned-precall-text",
        callsDigest: enterpriseCallsDigest(state.enterpriseCalls.map((entry) => entry.call)),
      })
    );
  for (const entry of state.enterpriseCalls || []) {
    if (!state.enterpriseCalls?.some((sibling) => sibling.signature)) continue;
    storeEnterpriseSignature(
      enterpriseReplayKey(
        state.signatureNamespace,
        "call",
        entry.call.id,
        state.enterpriseReplayHistory
      ),
      JSON.stringify(
        canonical({
          version: 2,
          identity: hashCall(entry.call),
          ...(entry.signature ? { signature: entry.signature } : { kind: "native-unsigned-call" }),
          callsDigest: enterpriseCallsDigest(state.enterpriseCalls.map((sibling) => sibling.call)),
          groupIds: state.enterpriseCalls.map((sibling) => sibling.call.id),
          nativePart: entry.nativePart,
          optionalDefaults: entry.optionalDefaults,
        })
      )
    );
  }
}
let signatureCacheMode: SignatureCacheMode = "enabled";
let persistedPruneCounter = 0;
const MAX_LOGGED_ERRORS = 50;
const loggedPersistenceErrors = new Set<string>();

function warnPersistenceError(operation: string, error: unknown) {
  if (process.env.NODE_ENV === "test") return;
  if (loggedPersistenceErrors.has(operation)) return;
  if (loggedPersistenceErrors.size >= MAX_LOGGED_ERRORS) {
    const first = loggedPersistenceErrors.values().next().value;
    if (first !== undefined) loggedPersistenceErrors.delete(first);
  }
  loggedPersistenceErrors.add(operation);
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[signature-cache] persisted ${operation} failed: ${message}`);
}

export function buildGeminiThoughtSignatureKey(namespace: unknown, toolCallId: unknown): unknown {
  if (
    typeof namespace === "string" &&
    namespace.length > 0 &&
    typeof toolCallId === "string" &&
    toolCallId.length > 0
  ) {
    return `${namespace}:${toolCallId}`;
  }
  return toolCallId;
}

function pruneExpired() {
  const now = Date.now();
  for (const [key, value] of signatures.entries()) {
    if (value.expiresAt <= now) {
      signatures.delete(key);
    }
  }

  while (signatures.size > MAX_SIGNATURES) {
    const oldestKey = signatures.keys().next().value;
    if (!oldestKey) break;
    signatures.delete(oldestKey);
  }
}

function serializePersistedEntry(entry: PersistedEntry): string {
  return JSON.stringify(entry);
}

function parsePersistedEntry(value: string, now = Date.now()) {
  try {
    const parsed = JSON.parse(value) as Partial<PersistedEntry>;
    if (typeof parsed.signature !== "string" || parsed.signature.length === 0) return null;
    const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : now;
    const expiresAt =
      typeof parsed.expiresAt === "number" ? parsed.expiresAt : now + PERSISTED_TTL_MS;
    if (expiresAt <= now) return null;
    return {
      entry: { signature: parsed.signature, createdAt, expiresAt },
      shouldRewrite: createdAt !== parsed.createdAt || expiresAt !== parsed.expiresAt,
    };
  } catch {
    if (!value) return null;
    return {
      entry: {
        signature: value,
        createdAt: now,
        expiresAt: now + PERSISTED_TTL_MS,
      },
      shouldRewrite: true,
    };
  }
}

function maybePrunePersistedSignatures(db: ReturnType<typeof getDbInstance>) {
  persistedPruneCounter += 1;
  if (persistedPruneCounter % 100 !== 0) return;

  const rows = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .all(NAMESPACE) as Array<{ key: string; value: string }>;

  const now = Date.now();
  const validRows: Array<{ key: string; createdAt: number }> = [];
  const keysToDelete = new Set<string>();

  for (const row of rows) {
    const parsed = parsePersistedEntry(row.value, now);
    if (!parsed) {
      keysToDelete.add(row.key);
      continue;
    }
    validRows.push({ key: row.key, createdAt: parsed.entry.createdAt });
  }

  if (rows.length <= MAX_PERSISTED_SIGNATURES && keysToDelete.size === 0) return;

  validRows.sort((a, b) => b.createdAt - a.createdAt);
  for (const row of validRows.slice(MAX_PERSISTED_SIGNATURES)) {
    keysToDelete.add(row.key);
  }

  if (keysToDelete.size === 0) return;
  const remove = db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?");
  const tx = db.transaction((keys: string[]) => {
    for (const key of keys) remove.run(NAMESPACE, key);
  });
  tx([...keysToDelete]);
}

export function storeGeminiThoughtSignature(toolCallId: unknown, signature: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return;
  if (typeof signature !== "string" || !signature) return;

  const now = Date.now();
  pruneExpired();
  signatures.set(toolCallId, {
    signature,
    expiresAt: now + MEMORY_TTL_MS,
  });

  try {
    const db = getDbInstance();
    db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
      NAMESPACE,
      toolCallId,
      serializePersistedEntry({ signature, createdAt: now, expiresAt: now + PERSISTED_TTL_MS })
    );
    maybePrunePersistedSignatures(db);
  } catch (error) {
    warnPersistenceError("store", error);
  }
}

export function getGeminiThoughtSignature(toolCallId: unknown) {
  if (typeof toolCallId !== "string" || !toolCallId) return null;

  pruneExpired();
  const entry = signatures.get(toolCallId);
  if (entry) return entry.signature;

  try {
    const db = getDbInstance();
    const row = db
      .prepare("SELECT value FROM key_value WHERE namespace = ? AND key = ?")
      .get(NAMESPACE, toolCallId) as { value: string } | undefined;

    if (row?.value) {
      const persisted = parsePersistedEntry(row.value);
      if (!persisted) {
        db.prepare("DELETE FROM key_value WHERE namespace = ? AND key = ?").run(
          NAMESPACE,
          toolCallId
        );
        return null;
      }

      signatures.set(toolCallId, {
        signature: persisted.entry.signature,
        expiresAt: Date.now() + MEMORY_TTL_MS,
      });

      if (persisted.shouldRewrite) {
        db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
          serializePersistedEntry(persisted.entry),
          NAMESPACE,
          toolCallId
        );
      }

      return persisted.entry.signature;
    }
  } catch (error) {
    warnPersistenceError("read", error);
  }

  return null;
}

export function normalizeSignatureCacheMode(value: unknown): SignatureCacheMode {
  return value === "bypass" || value === "bypass-strict" ? value : "enabled";
}

export function setGeminiThoughtSignatureMode(mode: unknown) {
  signatureCacheMode = normalizeSignatureCacheMode(mode);
}

export function getGeminiThoughtSignatureMode(): SignatureCacheMode {
  return signatureCacheMode;
}

function decodeSignature(signature: string): Buffer | null {
  if (!signature || (signature[0] !== "R" && signature[0] !== "E")) return null;

  const payload = signature.slice(1);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || payload.length % 4 === 1) {
    return null;
  }

  try {
    const decoded = Buffer.from(payload, "base64");
    if (decoded.length === 0) return null;

    const canonical = decoded.toString("base64").replace(/=+$/g, "");
    if (canonical !== payload.replace(/=+$/g, "")) {
      return null;
    }

    return decoded;
  } catch {
    return null;
  }
}

function readVarint(
  buffer: Buffer,
  startOffset: number
): { nextOffset: number; value: number } | null {
  let offset = startOffset;
  let result = 0;
  let shift = 0;

  while (offset < buffer.length && shift < 35) {
    const byte = buffer[offset];
    result |= (byte & 0x7f) << shift;
    offset += 1;

    if ((byte & 0x80) === 0) {
      return { nextOffset: offset, value: result };
    }

    shift += 7;
  }

  return null;
}

export function isValidBasicGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  return Boolean(decoded && decoded[0] === 0x12);
}

export function isValidFullGeminiThoughtSignature(signature: unknown): boolean {
  if (typeof signature !== "string") return false;
  const decoded = decodeSignature(signature);
  if (!decoded || decoded[0] !== 0x12) return false;

  const outerLength = readVarint(decoded, 1);
  if (!outerLength) return false;

  const outerEnd = outerLength.nextOffset + outerLength.value;
  if (outerEnd !== decoded.length) return false;

  const inner = decoded.subarray(outerLength.nextOffset, outerEnd);
  if (inner.length === 0 || inner[0] !== 0x0a) return false;

  const innerLength = readVarint(inner, 1);
  if (!innerLength) return false;

  return innerLength.nextOffset + innerLength.value === inner.length;
}

export function resolveGeminiThoughtSignature(
  toolCallId: unknown,
  clientSignature?: unknown
): string | null {
  const persisted = getGeminiThoughtSignature(toolCallId);
  if (typeof clientSignature !== "string" || clientSignature.length === 0) {
    return persisted;
  }

  if (signatureCacheMode === "enabled") {
    return persisted;
  }

  const isValid =
    signatureCacheMode === "bypass-strict"
      ? isValidFullGeminiThoughtSignature(clientSignature)
      : isValidBasicGeminiThoughtSignature(clientSignature);

  if (isValid) {
    return clientSignature;
  }

  console.warn(
    `[signature-cache] ${signatureCacheMode}: invalid client thought signature, falling back`
  );
  return persisted;
}

export function clearGeminiThoughtSignatures() {
  signatures.clear();
  signatureCacheMode = "enabled";
  try {
    const db = getDbInstance();
    db.prepare("DELETE FROM key_value WHERE namespace = ?").run(NAMESPACE);
  } catch (error) {
    warnPersistenceError("clear", error);
  }
}

export function clearGeminiThoughtSignatureMemoryForTests() {
  signatures.clear();
}

export function getGeminiThoughtSignatureMemorySizeForTests() {
  pruneExpired();
  return signatures.size;
}
