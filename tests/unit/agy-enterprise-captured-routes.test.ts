import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import { clearGeminiThoughtSignatures } from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { shouldSkipConnDisable } from "../../open-sse/services/combo/comboPredicates.ts";
import { shouldTripProviderBreakerForResult } from "../../src/sse/handlers/chatPredicates.ts";
const model = "gemini-3.8-flash-high";
const log = { debug() {}, info() {}, warn() {}, error() {} };
const raw = (flow: number) =>
  readFileSync(
    new URL(
      `../fixtures/agy-enterprise/captured-protocol/flow-${flow}.response.sse`,
      import.meta.url
    ),
    "utf8"
  );
const parts = (flow: number): Array<Record<string, unknown>> =>
  raw(flow)
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data: "))
    .flatMap((l) => JSON.parse(l.slice(6)).candidates?.[0]?.content?.parts || []);
const visible = (flow: number) =>
  parts(flow)
    .filter((p) => !p.thought)
    .map((p) => p.text || "")
    .join("");
const call = (flow: number) =>
  parts(flow).find((p) => p.functionCall)?.functionCall as {
    id: string;
    name: string;
    args: Record<string, unknown>;
  };
const context = "Synthetic context. ".repeat(3000);
test.after(() => resetDbInstance());

async function send(
  endpoint: string,
  stream: boolean,
  messages: Array<Record<string, unknown>>,
  connectionId: string,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal
) {
  const claude = endpoint === "/v1/messages";
  const responses = endpoint === "/v1/responses";
  const body = {
    model: `agy-enterprise/${model}`,
    stream,
    max_tokens: 65536,
    ...(responses ? { input: messages } : { messages }),
    tools: claude
      ? [{ name: "run_command", input_schema: { type: "object" } }]
      : responses
        ? [{ type: "function", name: "run_command", parameters: { type: "object" } }]
        : [{ type: "function", function: { name: "run_command", parameters: { type: "object" } } }],
    ...extra,
  };
  const result = await handleChatCore({
    body,
    modelInfo: { provider: "agy-enterprise", model },
    credentials: {
      accessToken: "synthetic",
      providerSpecificData: { projectId: "project-one", location: "us", userTier: "standard" },
    },
    log,
    clientRawRequest: {
      endpoint,
      body: structuredClone(body),
      signal,
      headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
    },
    connectionId,
    onCredentialsRefreshed: undefined,
    onRequestSuccess: undefined,
    onStreamFailure: undefined,
    onDisconnect: undefined,
    userAgent: null,
    comboName: null,
  });
  assert.ok(!(result instanceof Response));
  return result;
}

for (const endpoint of ["/v1/chat/completions", "/v1/responses", "/v1/messages"])
  for (const stream of [false, true]) {
    test(`enterpriseSixRouteModesContinueTools ${endpoint} ${stream ? "SSE" : "JSON"}`, async (t) => {
      clearGeminiThoughtSignatures();
      const connectionId = `${endpoint}-${stream}`;
      let flow = 25;
      let sent: Record<string, unknown>;
      t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        return new Response(raw(flow), { headers: { "Content-Type": "text/event-stream" } });
      });
      const claude = endpoint === "/v1/messages";
      const responses = endpoint === "/v1/responses";
      const messages: Array<Record<string, unknown>> = [
        { role: "user", content: context + "hello" },
      ];
      let result = await send(endpoint, stream, messages, connectionId);
      assert.equal(result.success, true, JSON.stringify(result));
      let text = await result.response.text();
      assert.match(text, /SANITIZED_TEXT/);
      assert.ok(sent.tools);
      assert.equal(sent.toolConfig, undefined);
      messages.push(
        {
          role: "assistant",
          content: claude ? [{ type: "text", text: visible(25) }] : visible(25),
        },
        { role: "user", content: "read synthetic file" }
      );
      for (const next of [33, 35, 38]) {
        flow = next;
        result = await send(endpoint, stream, messages, connectionId);
        assert.equal(result.success, true, JSON.stringify(result));
        text = await result.response.text();
        if (next !== 38) {
          const fc = call(next);
          assert.match(text, new RegExp(fc.id));
          if (stream) {
            if (claude) {
              assert.match(text, /input_json_delta/);
              assert.match(text, /"stop_reason":"tool_use"/);
              assert.equal((text.match(/event: message_stop/g) || []).length, 1);
            } else if (responses) {
              assert.match(text, /function_call/);
              assert.equal((text.match(/event: response.completed/g) || []).length, 1);
            } else assert.match(text, /"finish_reason":"tool_calls"/);
          } else {
            const json = JSON.parse(text);
            if (claude) assert.equal(json.stop_reason, "tool_use");
            else if (!responses) assert.equal(json.choices[0].finish_reason, "tool_calls");
          }
          if (claude)
            messages.push(
              {
                role: "assistant",
                content: [{ type: "tool_use", id: fc.id, name: fc.name, input: fc.args }],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: fc.id,
                    content: next === 33 ? "synthetic error" : "synthetic success",
                    is_error: next === 33,
                  },
                ],
              }
            );
          else if (responses)
            messages.push(
              {
                type: "function_call",
                call_id: fc.id,
                name: fc.name,
                arguments: JSON.stringify(fc.args),
              },
              {
                type: "function_call_output",
                call_id: fc.id,
                output: next === 33 ? "synthetic error" : "synthetic success",
              }
            );
          else
            messages.push(
              {
                role: "assistant",
                tool_calls: [
                  {
                    id: fc.id,
                    type: "function",
                    function: { name: fc.name, arguments: JSON.stringify(fc.args) },
                  },
                ],
              },
              {
                role: "tool",
                tool_call_id: fc.id,
                content: next === 33 ? "synthetic error" : "synthetic success",
              }
            );
        } else assert.match(text, /SANITIZED_TEXT/);
        if (next !== 33) {
          const contents = sent.contents as Array<{
            role: string;
            parts: Array<{ functionResponse?: { response: Record<string, unknown> } }>;
          }>;
          const results = contents.filter((c) => c.parts.some((p) => p.functionResponse));
          assert.equal(results.length, next === 35 ? 1 : 2);
          assert.ok(results.every((c) => c.role === "model"));
          assert.deepEqual(results[0].parts[0].functionResponse.response, {
            output: "synthetic error",
          });
        }
      }
      flow = 43;
      const png = JSON.parse(
        readFileSync(
          new URL(
            "../fixtures/agy-enterprise/captured-protocol/flow-43.request.json",
            import.meta.url
          ),
          "utf8"
        )
      ).contents.at(-1).parts[1].inlineData.data;
      const image = claude
        ? { type: "image", source: { type: "base64", media_type: "image/png", data: png } }
        : responses
          ? { type: "input_image", image_url: `data:image/png;base64,${png}` }
          : { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } };
      result = await send(
        endpoint,
        stream,
        [
          {
            role: "user",
            content: [{ type: responses ? "input_text" : "text", text: context }, image],
          },
        ],
        connectionId
      );
      assert.equal(result.success, true, JSON.stringify(result));
      await result.response.text();
      assert.equal(
        (sent.contents as Array<{ parts: Array<{ inlineData?: { data: string } }> }>)[0].parts[1]
          .inlineData.data,
        png
      );
    });
  }

test("enterpriseRouteErrorsDoNotCooldown", async (t) => {
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    dispatches++;
    return new Response();
  });
  for (const extra of [{ tool_choice: "required" }, {}]) {
    const messages = extra.tool_choice
      ? [{ role: "user", content: "hi" }]
      : [{ role: "assistant", content: "missing signed history" }];
    const result = await send("/v1/chat/completions", false, messages, "invalid-account", extra);
    assert.equal(result.success, false);
    assert.equal(result.status, 400);
    assert.equal(shouldSkipConnDisable(result, false, false, "agy-enterprise"), true);
    assert.equal(shouldTripProviderBreakerForResult(result, false, false), false);
  }
  assert.equal(dispatches, 0);
});

test("Enterprise real POST modules greet with declarations and count_tokens stays local", async (t) => {
  process.env.REQUIRE_API_KEY = "false";
  const { createProviderConnection } = await import("../../src/lib/db/providers.ts");
  await createProviderConnection({
    provider: "agy-enterprise",
    authType: "oauth",
    email: "fixture@example.com",
    projectId: "project-one",
    name: "fixture account",
    accessToken: "synthetic",
    isActive: true,
    testStatus: "active",
    providerSpecificData: {
      projectId: "project-one",
      location: "us",
      userTier: "standard",
      oauthClient: "builtin",
    },
  });
  const routes = [
    ["/v1/chat/completions", (await import("../../src/app/api/v1/chat/completions/route.ts")).POST],
    ["/v1/responses", (await import("../../src/app/api/v1/responses/route.ts")).POST],
    ["/v1/messages", (await import("../../src/app/api/v1/messages/route.ts")).POST],
  ] as const;
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    dispatches++;
    const body = JSON.parse(String(init.body));
    assert.equal(body.aicode.experience, model);
    assert.ok(body.tools);
    return new Response(raw(25), { headers: { "Content-Type": "text/event-stream" } });
  });
  for (const [endpoint, post] of routes)
    for (const stream of [false, true]) {
      const claude = endpoint === "/v1/messages";
      const responses = endpoint === "/v1/responses";
      const body = {
        model: `agy-enterprise/${model}`,
        stream,
        max_tokens: 65536,
        ...(responses ? { input: context } : { messages: [{ role: "user", content: context }] }),
        tools: claude
          ? [{ name: "run_command", input_schema: { type: "object" } }]
          : responses
            ? [{ type: "function", name: "run_command", parameters: { type: "object" } }]
            : [
                {
                  type: "function",
                  function: { name: "run_command", parameters: { type: "object" } },
                },
              ],
      };
      const response = await post(
        new Request(`http://localhost/api${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      assert.match(text, /SANITIZED_TEXT/);
    }
  const before = dispatches;
  const { POST } = await import("../../src/app/api/v1/messages/count_tokens/route.ts");
  const counted = await POST(
    new Request("http://localhost/api/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `agy-enterprise/${model}`,
        messages: [{ role: "user", content: "estimate this" }],
      }),
    })
  );
  assert.equal(counted.status, 200);
  assert.ok((await counted.json()).input_tokens > 0);
  assert.equal(dispatches, before);
});

test("Enterprise cached text from another account fails replay explicitly", async (t) => {
  const { updateSettings } = await import("../../src/lib/db/settings.ts");
  await updateSettings({ semanticCacheEnabled: true });
  clearGeminiThoughtSignatures();
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    dispatches++;
    return new Response(raw(25), { headers: { "Content-Type": "text/event-stream" } });
  });
  const messages = [{ role: "user", content: context + "cache test" }];
  const first = await send("/v1/chat/completions", false, messages, "cache-one", {
    temperature: 0,
    tools: undefined,
  });
  assert.equal(first.success, true);
  await first.response.text();
  const second = await send("/v1/chat/completions", false, messages, "cache-two", {
    temperature: 0,
    tools: undefined,
  });
  assert.equal(second.success, true);
  await second.response.text();
  assert.equal(dispatches, 1);
  const continuation = await send(
    "/v1/chat/completions",
    false,
    [
      ...messages,
      { role: "assistant", content: visible(25) },
      { role: "user", content: "continue" },
    ],
    "cache-two"
  );
  assert.equal(continuation.status, 400);
  assert.match(continuation.error, /replay/);
  assert.equal(dispatches, 1);
});

test("Enterprise client cancellation releases upstream without completing partial replay", async (t) => {
  let cancelled = false;
  const controller = new AbortController();
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'
              )
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } }
      )
  );
  const result = await send(
    "/v1/chat/completions",
    true,
    [{ role: "user", content: "cancel test" }],
    "cancel-account",
    {},
    controller.signal
  );
  assert.equal(result.success, true);
  const reader = result.response.body.getReader();
  await reader.read();
  controller.abort();
  await reader.cancel();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("Enterprise interfaces share API key authorization", async () => {
  const { clientApiPolicy } = await import("../../src/server/authz/policies/clientApi.ts");
  const { classifyRoute } = await import("../../src/server/authz/classify.ts");
  const previous = process.env.REQUIRE_API_KEY;
  process.env.REQUIRE_API_KEY = "true";
  try {
    for (const endpoint of [
      "/v1/chat/completions",
      "/v1/responses",
      "/v1/messages",
      "/v1/messages/count_tokens",
    ]) {
      const request = new Request(`http://localhost/api${endpoint}`, { method: "POST" });
      const result = await clientApiPolicy.evaluate({
        request,
        classification: classifyRoute(new URL(request.url).pathname, "POST"),
        requestId: "fixture-auth",
      });
      assert.equal(result.allow, false);
      if (result.allow === false) assert.equal(result.status, 401);
    }
  } finally {
    if (previous === undefined) delete process.env.REQUIRE_API_KEY;
    else process.env.REQUIRE_API_KEY = previous;
  }
});
