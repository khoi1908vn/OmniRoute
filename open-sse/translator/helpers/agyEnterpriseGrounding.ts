type GroundingState = {
  enterpriseSearchQueries?: Set<string>;
  enterpriseSearchSources?: Set<string>;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function escapeText(text: string): string {
  return text
    .replace(/[\r\n\u0000-\u001f]/g, " ")
    .replace(/[\\`*_\[\]]/g, "\\$&")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Render only real sources and query text; suggestion HTML is never a citation. */
export function enterpriseGroundingText(metadata: unknown, state: GroundingState): string {
  const grounding = record(metadata);
  state.enterpriseSearchQueries ??= new Set();
  state.enterpriseSearchSources ??= new Set();
  const queries: string[] = [];
  const sources: string[] = [];
  const rawQueries = grounding.webSearchQueries ?? grounding.web_search_queries;
  if (Array.isArray(rawQueries)) {
    for (const query of rawQueries) {
      if (typeof query !== "string" || !query || state.enterpriseSearchQueries.has(query)) continue;
      state.enterpriseSearchQueries.add(query);
      queries.push(escapeText(query));
    }
  }
  const chunks = grounding.groundingChunks ?? grounding.grounding_chunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) {
      const web = record(record(chunk).web);
      if (typeof web.uri !== "string") continue;
      let url: URL;
      try {
        url = new URL(web.uri);
      } catch {
        continue;
      }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      const href = url.href.replace(/</g, "%3C").replace(/>/g, "%3E");
      if (state.enterpriseSearchSources.has(href)) continue;
      state.enterpriseSearchSources.add(href);
      const title = typeof web.title === "string" && web.title ? web.title : url.hostname;
      sources.push(`- [${escapeText(title)}](<${href}>)`);
    }
  }
  return (
    (queries.length ? `\n\nSearch queries: ${queries.join("; ")}` : "") +
    (sources.length ? `\n\nSources:\n${sources.join("\n")}` : "")
  );
}
