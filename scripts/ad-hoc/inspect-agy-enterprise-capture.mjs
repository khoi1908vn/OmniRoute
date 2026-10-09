import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Offline only. No replay, credential use, private body logging, or source mutation.
const source = path.resolve(process.argv[2] || ".build/all.fixed.har");
const output = path.resolve(process.argv[3] || "tests/fixtures/agy-enterprise/captured-protocol");
const bytes = fs.readFileSync(source);
const har = JSON.parse(bytes.toString("utf8"));
const indices = [23, 25, 33, 35, 38, 43];
const aliases = new Map();
const replacements = new Map();
const redactions = [];
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
function alias(value, kind) {
  const key = `${kind}:${value}`;
  if (!aliases.has(key))
    aliases.set(
      key,
      `${kind}_${[...aliases.keys()].filter((x) => x.startsWith(`${kind}:`)).length + 1}`
    );
  return aliases.get(key);
}
function walk(value, key = "", parent = "", location = "") {
  if (Array.isArray(value)) return value.map((x, i) => walk(x, key, parent, `${location}/${i}`));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, x]) => [k, walk(x, k, key, `${location}/${k}`)])
    );
  if (typeof value !== "string" || value === "") return value;
  let safe;
  if (key === "thoughtSignature") safe = alias(value, "SYNTHETIC_SIGNATURE");
  else if (key === "data" && parent === "inlineData") safe = png;
  else if (key === "id" || key === "responseId" || key.endsWith("_id"))
    safe = alias(value, key === "id" ? "call" : key);
  else if (
    [
      "experience",
      "userTier",
      "role",
      "mimeType",
      "modelVersion",
      "finishReason",
      "modality",
      "type",
      "name",
      "required",
      "enum",
      "minLength",
      "maxLength",
      "pattern",
      "model_enum",
      "used_claude",
      "used_claude_conservative",
      "used_non_gemini_model",
      "last_step_index",
    ].includes(key)
  )
    safe = value;
  else safe = alias(value, key === "output" ? "SANITIZED_OUTPUT" : "SANITIZED_TEXT");
  if (safe !== value) {
    replacements.set(value, safe);
    redactions.push({
      location,
      kind: key,
      originalUtf8Bytes: Buffer.byteLength(value),
      originalCharacters: value.length,
    });
  }
  return safe;
}
function substitute(raw) {
  // Replace JSON string tokens only; retain original whitespace, key order and SSE framing.
  return raw.replace(/"(?:[^"\\]|\\.)*"/g, (token) => {
    const value = JSON.parse(token);
    return replacements.has(value) ? JSON.stringify(replacements.get(value)) : token;
  });
}
function headers(input) {
  return input.map(({ name, value }) => ({
    name,
    value:
      /^(host|user-agent|content-type|accept|accept-encoding|transfer-encoding|content-encoding)$/i.test(
        name
      )
        ? value
        : /^authorization$/i.test(name)
          ? `${value.split(" ")[0]} SANITIZED_TOKEN`
          : "SANITIZED_HEADER",
  }));
}
fs.mkdirSync(output, { recursive: true });
const manifest = {
  source: ".build/all.fixed.har",
  sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  creator: har.log.creator,
  originalEntries: har.log.entries.length,
  originalMitmFound: false,
  selection: "All six Business AI Code streamGenerateContent flows; unrelated traffic excluded",
  transformations:
    "JSON string-token substitutions only in bodies. All nonempty text/descriptions/argument strings/results, opaque signatures, IDs and private image bytes replaced. Structure, booleans, numbers, schema keys, model names and SSE event boundaries preserved. Headers independently sanitized. Synthetic signatures are deliberately non-replayable; image replaced with synthetic 1x1 PNG.",
  flows: [],
  redactions,
};
const signatures = [];
for (const index of indices) {
  const entry = har.log.entries[index];
  const url = new URL(entry.request.url);
  if (
    url.hostname !== "businessaicode.us.rep.googleapis.com" ||
    !url.pathname.endsWith(":streamGenerateContent")
  )
    throw new Error("Unexpected selected endpoint");
  if (entry.response.content.encoding)
    throw new Error("Encoded HAR response requires explicit decoding");
  const request = JSON.parse(entry.request.postData.text);
  const response = entry.response.content.text;
  const events = response
    .split(/\r?\n/)
    .filter((x) => x.startsWith("data:"))
    .map((x) => JSON.parse(x.slice(5)));
  const allParts = events.flatMap((x) => x.candidates || []).flatMap((x) => x.content?.parts || []);
  const replay = request.contents
    .flatMap((x) => x.parts)
    .filter((x) => x.thoughtSignature)
    .map((x) => ({
      priorFlow: signatures.find((s) => s.value === x.thoughtSignature)?.index ?? null,
      characters: x.thoughtSignature.length,
    }));
  walk(request, "", "", `flow-${index}/request`);
  events.forEach((x, i) => walk(x, "", "", `flow-${index}/response/${i}`));
  const image = request.contents.flatMap((x) => x.parts).find((x) => x.inlineData)?.inlineData;
  const imageBytes = image && Buffer.from(image.data, "base64");
  manifest.flows.push({
    index,
    scenario:
      index === 23
        ? "text-probe"
        : index === 25
          ? "text-with-tools"
          : index === 33
            ? "first-tool-call"
            : index === 35
              ? "error-result-and-retry-call"
              : index === 38
                ? "success-result-and-final-text"
                : "inline-image",
    requestBodyBytes: Buffer.byteLength(entry.request.postData.text),
    responseBodyBytes: Buffer.byteLength(response),
    eventCount: events.length,
    httpVersion: entry.request.httpVersion,
    status: entry.response.status,
    receiveMs: entry.timings.receive,
    model: request.aicode.experience,
    responseModel: events[0].modelVersion,
    requestRootKeys: Object.keys(request),
    toolConfigPresent: Object.hasOwn(request, "toolConfig"),
    declarationCount: request.tools?.flatMap((x) => x.functionDeclarations || []).length || 0,
    toolCallCount: allParts.filter((x) => x.functionCall).length,
    signatureReplay: replay,
    usage: events.at(-1).usageMetadata,
    ...(image
      ? {
          image: {
            mimeType: image.mimeType,
            base64Characters: image.data.length,
            decodedBytes: imageBytes.length,
            width: imageBytes.readUInt32BE(16),
            height: imageBytes.readUInt32BE(20),
          },
        }
      : {}),
  });
  const metadata = {
    request: {
      url: entry.request.url.replace(/projects\/[^/]+/, "projects/SANITIZED_PROJECT"),
      method: entry.request.method,
      httpVersion: entry.request.httpVersion,
      headers: headers(entry.request.headers),
      contentType: entry.request.postData.mimeType,
    },
    response: {
      status: entry.response.status,
      httpVersion: entry.response.httpVersion,
      headers: headers(entry.response.headers),
      contentType: entry.response.content.mimeType,
    },
  };
  fs.writeFileSync(
    path.join(output, `flow-${index}.http.json`),
    JSON.stringify(metadata, null, 2) + "\n"
  );
  fs.writeFileSync(
    path.join(output, `flow-${index}.request.json`),
    substitute(entry.request.postData.text)
  );
  fs.writeFileSync(path.join(output, `flow-${index}.response.sse`), substitute(response));
  signatures.push(
    ...allParts.filter((x) => x.thoughtSignature).map((x) => ({ index, value: x.thoughtSignature }))
  );
}
fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
// Check every replaced private string is absent from every exported file.
const exported = fs
  .readdirSync(output)
  .filter((x) => x.endsWith(".json") || x.endsWith(".sse"))
  .map((x) => fs.readFileSync(path.join(output, x), "utf8"))
  .join("\n");
for (const [privateValue] of replacements)
  if (
    privateValue.length > 24 &&
    (exported.includes(privateValue) ||
      exported.includes(JSON.stringify(privateValue).slice(1, -1)))
  )
    throw new Error("Private value survived export");
const secrets = new Set();
function gather(value) {
  if (typeof value === "string" && value.length > 8) secrets.add(value);
  else if (Array.isArray(value)) value.forEach(gather);
  else if (value && typeof value === "object") Object.values(value).forEach(gather);
}
for (const entry of har.log.entries) {
  for (const header of [...entry.request.headers, ...entry.response.headers]) {
    if (/authorization|cookie|api.key|auth.token/i.test(header.name)) {
      gather(header.value);
      if (/authorization/i.test(header.name)) gather(header.value.split(" ").slice(1).join(" "));
    }
  }
  const url = new URL(entry.request.url);
  gather(url.pathname.match(/projects\/([^/]+)/)?.[1]);
  if (url.hostname === "oauth2.googleapis.com" || url.pathname.includes("userinfo")) {
    try {
      gather(JSON.parse(entry.response.content.text));
    } catch {
      /* Non-JSON body. */
    }
    if (entry.request.postData?.text)
      new URLSearchParams(entry.request.postData.text).forEach(gather);
  }
}
for (const secret of secrets)
  if (exported.includes(secret) || exported.includes(JSON.stringify(secret).slice(1, -1)))
    throw new Error("Credential or PII survived export");
console.log(
  JSON.stringify({
    exportedFlows: indices.length,
    files: 19,
    redactions: redactions.length,
    privateStringCheck: "PASS",
    credentialAndPiiCheck: "PASS",
  })
);
