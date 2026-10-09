import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { AgyEnterpriseExecutor } from "../../open-sse/executors/agyEnterprise.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { enterpriseGroundingText } from "../../open-sse/translator/helpers/agyEnterpriseGrounding.ts";
import { parseSSEToGeminiResponse } from "../../open-sse/handlers/sseParser/geminiResponse.ts";
import { buildAgyEnterpriseReplayNamespace } from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { geminiToClaudeResponse } from "../../open-sse/translator/response/gemini-to-claude.ts";
import { buildGeminiTools } from "../../open-sse/translator/helpers/geminiToolsSanitizer.ts";

const model = "gemini-3.5-flash-lite";
const credentials = {
  _provider: "agy-enterprise",
  accessToken: "synthetic",
  providerSpecificData: { projectId: "project-one", location: "us", userTier: "standard" },
};
const log = { debug() {}, info() {}, warn() {}, error() {} };
const message = { role: "user", content: "Search Wikipedia shutdown rumors" };
const search = { type: "web_search_20250305", name: "web_search" };
const read = { name: "Read", input_schema: { type: "object", properties: {} } };
test.after(() => resetDbInstance());

function visibleReply(raw: string, endpoint: string, stream: boolean): string {
  if (stream) {
    return raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(5)))
      .map(
        (event) =>
          event.choices?.[0]?.delta?.content ||
          (event.delta?.type === "text_delta" ? event.delta.text : "") ||
          (event.type === "response.output_text.delta" ? event.delta : "")
      )
      .join("");
  }
  const reply = JSON.parse(raw);
  if (endpoint === "/v1/messages")
    return reply.content
      .filter((part: { type: string }) => part.type === "text")
      .map((part: { text: string }) => part.text)
      .join("");
  if (endpoint === "/v1/responses")
    return reply.output
      .filter((item: { type: string }) => item.type === "message")
      .flatMap((item: { content: Array<{ text?: string }> }) => item.content)
      .map((part: { text?: string }) => part.text || "")
      .join("");
  return reply.choices[0].message.content;
}

test("Enterprise accepts captured native search and preserves account context", () => {
  const body = new AgyEnterpriseExecutor().transformRequest(
    model,
    {
      contents: [{ role: "user", parts: [{ text: message.content }] }],
      tools: [{ enterpriseWebSearch: {} }],
    },
    false,
    credentials
  );
  assert.deepEqual(body.tools, [{ enterpriseWebSearch: {} }]);
  assert.deepEqual(body.aicode, { experience: model });
  assert.deepEqual(body.entitlement, { userTier: "standard" });
});

test("Claude hosted and Claude Code search map natively without losing Read", () => {
  for (const declaration of [search, { name: "WebSearch", input_schema: { type: "object" } }]) {
    const translated = claudeToGeminiRequest(
      model,
      { messages: [message], tools: [declaration, read] },
      true,
      credentials
    );
    assert.deepEqual(translated.tools[0], { enterpriseWebSearch: {} });
    assert.equal(translated.tools[1].functionDeclarations[0].name, "Read");
    assert.equal(translated.toolConfig, undefined);
    assert.doesNotThrow(() =>
      new AgyEnterpriseExecutor().transformRequest(model, translated, true, credentials)
    );
  }
});

test("OpenAI hosted and function search declarations map to Enterprise search", () => {
  for (const declaration of [
    { type: "web_search_preview" },
    { type: "function", function: { name: "WebSearch", parameters: { type: "object" } } },
    { enterpriseWebSearch: {} },
  ]) {
    const translated = openaiToGeminiRequest(
      model,
      { messages: [message], tools: [declaration] },
      false,
      credentials
    );
    assert.deepEqual(translated.tools, [{ enterpriseWebSearch: {} }]);
    assert.equal(translated.toolConfig, undefined);
  }
});

test("unsupported native search restrictions fail locally rather than being discarded", () => {
  for (const restriction of [
    { allowed_domains: ["wikipedia.org"] },
    { max_uses: 1 },
    { user_location: { country: "US" } },
  ]) {
    assert.throws(
      () =>
        claudeToGeminiRequest(
          model,
          { messages: [message], tools: [{ ...search, ...restriction }] },
          false,
          credentials
        ),
      /Enterprise.*search/i
    );
  }
});

test("domain exclusions survive mapping; invalid native search options are rejected", () => {
  const translated = claudeToGeminiRequest(
    model,
    { messages: [message], tools: [{ ...search, blocked_domains: ["example.com"] }] },
    false,
    credentials
  );
  assert.deepEqual(translated.tools, [
    { enterpriseWebSearch: { excludeDomains: ["example.com"] } },
  ]);
  assert.throws(() =>
    new AgyEnterpriseExecutor().transformRequest(
      model,
      {
        contents: [{ parts: [{ text: "Hi" }] }],
        tools: [{ enterpriseWebSearch: { max_uses: 1 } }],
      },
      false,
      credentials
    )
  );
});

test("personal Gemini keeps existing custom WebSearch function behavior", () => {
  const translated = claudeToGeminiRequest(
    model,
    { messages: [message], tools: [{ name: "WebSearch", input_schema: { type: "object" } }, read] },
    true,
    { _provider: "gemini" }
  );
  assert.equal(translated.tools[0].functionDeclarations.length, 2);
  assert.equal(translated.tools[0].enterpriseWebSearch, undefined);
});

test("multiple search declarations cannot erase earlier domain exclusions", () => {
  const translated = claudeToGeminiRequest(
    model,
    {
      messages: [message],
      tools: [
        { ...search, blocked_domains: ["example.com"] },
        { enterpriseWebSearch: { excludeDomains: ["example.net"] } },
        search,
      ],
    },
    false,
    credentials
  );
  assert.deepEqual(translated.tools, [
    { enterpriseWebSearch: { excludeDomains: ["example.com", "example.net"] } },
  ]);
});

test("native search sharing a tool entry cannot silently discard grouped functions", () => {
  const tools = buildGeminiTools(
    [
      {
        enterpriseWebSearch: {},
        functionDeclarations: [{ name: "Read", parameters: { type: "object" } }],
      },
    ],
    { agyEnterprise: true }
  );
  assert.equal(tools!.length, 2);
  assert.equal(tools![1].functionDeclarations![0].name, "Read");
});

test("grounding cannot bypass native text boundaries across thinking parts", () => {
  const history = [{ role: "user", parts: [{ text: message.content }] }];
  const result = parseSSEToGeminiResponse(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: {
            parts: [
              { text: "Before thinking." },
              { thought: true, text: "Reasoning" },
              { text: "After thinking.", thoughtSignature: "synthetic-boundary-signature" },
            ],
          },
          finishReason: "STOP",
          groundingMetadata: { webSearchQueries: ["Query"] },
        },
      ],
    })}\n\n`,
    model,
    { provider: "agy-enterprise", connectionId: "search-thought-boundary", history }
  );
  const reply = (result!.choices as Array<{ message: { content: string } }>)[0].message.content;
  assert.throws(
    () =>
      claudeToGeminiRequest(
        model,
        {
          messages: [
            message,
            {
              role: "assistant",
              content: [
                { type: "text", text: "Before thinking." },
                {
                  type: "thinking",
                  thinking: "Reasoning",
                  signature: "synthetic-boundary-signature",
                },
                { type: "text", text: reply.slice("Before thinking.".length) },
              ],
            },
          ],
        },
        false,
        { ...credentials, _signatureNamespace: "search-thought-boundary" }
      ),
    /replay rejected/
  );
});

test("malformed native search and privacy restrictions cannot become unrestricted search", () => {
  for (const declaration of [
    { enterpriseWebSearch: null },
    { enterpriseWebSearch: [] },
    { type: "web_search", external_web_access: false },
  ]) {
    assert.throws(
      () =>
        openaiToGeminiRequest(
          model,
          { messages: [message], tools: [declaration] },
          false,
          credentials
        ),
      /Enterprise.*search/i
    );
  }
});

test("grounding accumulates queries and real sources without trusting rendered suggestion HTML", () => {
  const state = {};
  const queryOnly = {
    webSearchQueries: ["Wikipedia shutdown rumors"],
    searchEntryPoint: { renderedContent: "<script>evil()</script>" },
  };
  assert.equal(
    enterpriseGroundingText(queryOnly, state),
    "\n\nSearch queries: Wikipedia shutdown rumors"
  );
  assert.equal(enterpriseGroundingText(queryOnly, state), "");
  const text = enterpriseGroundingText(
    {
      ...queryOnly,
      groundingChunks: [
        { web: { uri: "javascript:evil()", title: "bad" } },
        { web: { uri: "https://user:password@example.com", title: "credential" } },
        { web: { uri: "https://example.com/", title: "<script>[x](evil)</script>" } },
        { web: { uri: "https://example.com/", title: "duplicate" } },
      ],
    },
    state
  );
  assert.match(text, /https:\/\/example.com\//);
  assert.doesNotMatch(text, /javascript:|password|<script>|duplicate|Search queries/);
  assert.equal(
    enterpriseGroundingText({ groundingChunks: [{ web: { uri: "https://example.com/" } }] }, state),
    ""
  );
});

test("captured query-only unsigned search can continue only with exact scoped rendered history", () => {
  const history = [{ role: "user", parts: [{ text: message.content }] }];
  const result = parseSSEToGeminiResponse(
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Wikipedia remains operational." }] },
          finishReason: "STOP",
          groundingMetadata: {
            webSearchQueries: ["Wikipedia shutdown rumors"],
            searchEntryPoint: { renderedContent: "<div>suggestions</div>" },
          },
        },
      ],
    })}\n\n`,
    model,
    { provider: "agy-enterprise", connectionId: "unsigned-search", history }
  );
  const reply = (result!.choices as Array<{ message: { content: string } }>)[0].message.content;
  assert.match(reply, /Search queries/);
  assert.doesNotMatch(reply, /Sources|suggestions/);
  const body = {
    messages: [
      message,
      { role: "assistant", content: reply },
      { role: "user", content: "Continue" },
    ],
    tools: [search],
  };
  const scoped = { ...credentials, _signatureNamespace: "unsigned-search" };
  const translated = openaiToGeminiRequest(model, body, false, scoped);
  assert.deepEqual(translated.contents![1], {
    role: "model",
    parts: [{ text: "Wikipedia remains operational." }],
  });
  for (const altered of [reply + "changed", reply.replace("Wikipedia", "Another site")]) {
    assert.throws(
      () =>
        openaiToGeminiRequest(
          model,
          { ...body, messages: [message, { role: "assistant", content: altered }] },
          false,
          scoped
        ),
      /replay rejected/
    );
  }
  assert.throws(
    () =>
      openaiToGeminiRequest(model, body, false, {
        ...scoped,
        _signatureNamespace: "another-search-account",
      }),
    /replay rejected/
  );
  assert.throws(
    () => openaiToGeminiRequest("another-experience", body, false, scoped),
    /replay rejected/
  );
  assert.throws(
    () =>
      openaiToGeminiRequest(
        model,
        {
          ...body,
          messages: [{ role: "user", content: "Changed origin" }, ...body.messages.slice(1)],
        },
        false,
        scoped
      ),
    /replay rejected/
  );
});

test("search footer after a client tool restores original precall text and signed call", () => {
  const history = [{ role: "user", parts: [{ text: message.content }] }];
  const call = { id: "search-read-call", name: "Read", args: { path: "docs" } };
  const nativeParts = [
    { text: "Read the docs." },
    { functionCall: call, thoughtSignature: "synthetic-call-signature" },
  ];
  const state = {
    provider: "agy-enterprise",
    signatureNamespace: buildAgyEnterpriseReplayNamespace("search-with-call", model),
    enterpriseReplayHistory: history,
  };
  const events = geminiToClaudeResponse(
    {
      candidates: [
        {
          content: { parts: nativeParts },
          finishReason: "STOP",
          groundingMetadata: { webSearchQueries: ["Docs query"] },
        },
      ],
    },
    state
  )!;
  const content: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type === "content_block_start")
      content[event.index] = structuredClone(event.content_block);
    if (event.delta?.type === "text_delta") content[event.index].text += event.delta.text;
    if (event.delta?.type === "input_json_delta")
      content[event.index].input = JSON.parse(event.delta.partial_json);
  }
  assert.equal(content.length, 3);
  const translated = claudeToGeminiRequest(
    model,
    { messages: [message, { role: "assistant", content }], tools: [search, read] },
    false,
    { ...credentials, _signatureNamespace: "search-with-call" }
  );
  assert.deepEqual(translated.contents[1], { role: "model", parts: nativeParts });
  const changed = structuredClone(content);
  changed[1].input = { path: "other-docs" };
  assert.throws(
    () =>
      claudeToGeminiRequest(
        model,
        { messages: [message, { role: "assistant", content: changed }], tools: [search, read] },
        false,
        { ...credentials, _signatureNamespace: "search-with-call" }
      ),
    /replay rejected/
  );
});

for (const endpoint of ["/v1/chat/completions", "/v1/responses", "/v1/messages"])
  for (const stream of [false, true]) {
    test(`native Enterprise search transport ${endpoint} ${stream ? "SSE" : "JSON"}`, async (t) => {
      const claude = endpoint === "/v1/messages";
      const responses = endpoint === "/v1/responses";
      const tools = claude
        ? [search, read]
        : [
            { type: "web_search_preview" },
            responses
              ? { type: "function", name: "Read", parameters: { type: "object" } }
              : { type: "function", function: { name: "Read", parameters: { type: "object" } } },
          ];
      let calls = 0;
      t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
        calls++;
        assert.match(String(url), /businessaicode\.us\.rep\.googleapis\.com/);
        const sent = JSON.parse(String(init.body));
        assert.deepEqual(sent.tools[0], { enterpriseWebSearch: {} });
        assert.equal(sent.tools[1].functionDeclarations[0].name, "Read");
        assert.deepEqual(sent.entitlement, { userTier: "standard" });
        assert.equal(sent.toolConfig, undefined);
        if (calls === 2) {
          assert.deepEqual(sent.contents[1], {
            role: "model",
            parts: [
              {
                text: "Wikipedia remains operational.",
                thoughtSignature: "synthetic-search-signature",
              },
            ],
          });
        }
        const candidate = {
          content: {
            role: "model",
            parts: [
              {
                text: "Wikipedia remains operational.",
                thoughtSignature: "synthetic-search-signature",
              },
            ],
          },
          finishReason: "STOP",
          groundingMetadata: {
            webSearchQueries: ["Wikipedia shutdown rumors"],
            searchEntryPoint: {
              renderedContent:
                '<a href="https://example.com/query-chip">Query chip</a><script>evil()</script>',
            },
            groundingChunks: [{ web: { uri: "https://www.wikipedia.org/", title: "Wikipedia" } }],
          },
        };
        return new Response(
          `data: ${JSON.stringify({ candidates: [candidate], usageMetadata: { promptTokenCount: 89, candidatesTokenCount: 117, totalTokenCount: 206 } })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } }
        );
      });
      const body = {
        model: `agy-enterprise/${model}`,
        stream,
        max_tokens: 1024,
        ...(responses ? { input: [message] } : { messages: [message] }),
        tools,
      };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: "agy-enterprise", model },
        credentials: { ...credentials },
        log,
        clientRawRequest: {
          endpoint,
          body: structuredClone(body),
          headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
        },
        connectionId: `search-${endpoint}-${stream}`,
        onCredentialsRefreshed: undefined,
        onRequestSuccess: undefined,
        onStreamFailure: undefined,
        onDisconnect: undefined,
        userAgent: null,
        comboName: null,
      });
      assert.ok(!(result instanceof Response));
      assert.equal(result.success, true, JSON.stringify(result));
      const text = await result.response.text();
      assert.equal(calls, 1);
      assert.match(text, /Wikipedia remains operational/);
      assert.match(text, /Wikipedia shutdown rumors/);
      assert.match(text, /https:\/\/www.wikipedia.org\//);
      assert.doesNotMatch(text, /query-chip|evil\(\)|encrypted_content|omniroute_web_search/);
      const assistant = visibleReply(text, endpoint, stream);
      assert.match(assistant, /Search queries/);
      const nextBody = {
        ...body,
        ...(responses
          ? {
              input: [
                message,
                { role: "assistant", content: assistant },
                { role: "user", content: "Explain further" },
              ],
            }
          : {
              messages: [
                message,
                { role: "assistant", content: assistant },
                { role: "user", content: "Explain further" },
              ],
            }),
      };
      const next = await handleChatCore({
        body: nextBody,
        modelInfo: { provider: "agy-enterprise", model },
        credentials: { ...credentials },
        log,
        clientRawRequest: {
          endpoint,
          body: structuredClone(nextBody),
          headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
        },
        connectionId: `search-${endpoint}-${stream}`,
        onCredentialsRefreshed: undefined,
        onRequestSuccess: undefined,
        onStreamFailure: undefined,
        onDisconnect: undefined,
        userAgent: null,
        comboName: null,
      });
      assert.ok(!(next instanceof Response));
      assert.equal(next.success, true, JSON.stringify(next));
      await next.response.text();
      assert.equal(calls, 2);
    });
  }
