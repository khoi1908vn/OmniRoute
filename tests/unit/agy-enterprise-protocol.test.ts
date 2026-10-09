import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";
import { shouldSkipConnDisable } from "../../open-sse/services/combo/comboPredicates.ts";
import { shouldTripProviderBreakerForResult } from "../../src/sse/handlers/chatPredicates.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";

const terminal = JSON.parse(
  readFileSync(new URL("../fixtures/agy-enterprise/terminal.json", import.meta.url), "utf8")
);
const log = { debug() {}, info() {}, warn() {}, error() {} };
// Synthetic context makes the captured 12,140-token usage physically plausible.
// The private CLI harness was not recoverable from screenshots.
const input = "Synthetic context. ".repeat(3000) + "Hello";

test.after(() => resetDbInstance());

test("Gemini buffered prompt safety blocks preserve filtered termination", async (t) => {
  for (const wrapped of [false, true]) {
    for (const withUsage of [false, true]) {
      for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) {
        await t.test(
          `${endpoint}, ${wrapped ? "wrapped" : "direct"}, ${withUsage ? "with" : "without"} usage`,
          async (s) => {
            const feedback = {
              promptFeedback: { blockReason: "SAFETY" },
              ...(withUsage ? { usageMetadata: terminal.usageMetadata } : {}),
            };
            const event = wrapped ? { response: feedback } : feedback;
            s.mock.method(
              globalThis,
              "fetch",
              async () =>
                new Response(`data: ${JSON.stringify(event)}\n\n`, {
                  headers: { "Content-Type": "text/event-stream" },
                })
            );
            const responses = endpoint === "/v1/responses";
            const body = {
              model: "agy-enterprise/gemini-3.5-flash-lite",
              stream: false,
              ...(responses ? { input } : { messages: [{ role: "user", content: input }] }),
            };
            const result = await handleChatCore({
              body,
              modelInfo: { provider: "agy-enterprise", model: "gemini-3.5-flash-lite" },
              credentials: {
                accessToken: "synthetic",
                providerSpecificData: {
                  projectId: "project-one",
                  location: "us",
                  userTier: "standard",
                },
              },
              log,
              clientRawRequest: {
                endpoint,
                body,
                headers: new Headers({ accept: "application/json" }),
              },
              onCredentialsRefreshed: undefined,
              onRequestSuccess: undefined,
              onStreamFailure: undefined,
              onDisconnect: undefined,
              connectionId: undefined,
              userAgent: null,
              comboName: null,
            });
            assert.ok(!(result instanceof Response));
            assert.equal(result.success, true, JSON.stringify(result));
            assert.equal(result.response?.status, 200);
            if (responses) {
              const responsesJson = await result.response!.json();
              assert.equal(responsesJson.status, "incomplete");
              assert.equal(responsesJson.incomplete_details.reason, "content_filter");
              if (withUsage) assert.equal(responsesJson.usage.total_tokens, 12224);
            } else {
              const chatJson = await result.response!.json();
              assert.equal(chatJson.choices[0].message.content, null);
              assert.equal(chatJson.choices[0].finish_reason, "content_filter");
              if (withUsage) assert.equal(chatJson.usage.total_tokens, 12224);
            }
          }
        );
      }
    }
  }
});

for (const endpoint of ["/v1/chat/completions", "/v1/responses"])
  for (const stream of [false, true])
    for (const invalid of ["tools", "images", "experience"] as const) {
      test(`Enterprise invalid text-only input is a request failure without health penalties (${endpoint}, ${stream ? "SSE" : "JSON"}, ${invalid})`, async (t) => {
        let dispatches = 0;
        t.mock.method(globalThis, "fetch", async () => {
          dispatches++;
          return new Response(`data: ${JSON.stringify(terminal)}\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        });
        const responses = endpoint === "/v1/responses";
        const model = invalid === "experience" ? "x".repeat(201) : "gemini-3.5-flash-lite";
        const image = "data:image/png;base64,c3ludGhldGlj";
        const content =
          invalid === "images"
            ? [
                responses
                  ? { type: "input_image", image_url: image }
                  : { type: "image_url", image_url: { url: image } },
              ]
            : "Hello";
        const body = {
          model: `agy-enterprise/${model}`,
          stream,
          ...(responses
            ? { input: [{ role: "user", content }] }
            : { messages: [{ role: "user", content }] }),
          ...(invalid === "tools"
            ? {
                tool_choice: "required",
                tools: [
                  responses
                    ? { type: "function", name: "lookup", parameters: { type: "object" } }
                    : {
                        type: "function",
                        function: { name: "lookup", parameters: { type: "object" } },
                      },
                ],
              }
            : {}),
        };
        const result = await handleChatCore({
          body,
          modelInfo: { provider: "agy-enterprise", model },
          credentials: {
            accessToken: "synthetic",
            providerSpecificData: {
              projectId: "project-one",
              location: "us",
              userTier: "standard",
              oauthClient: "builtin",
            },
          },
          log,
          clientRawRequest: {
            endpoint,
            body: structuredClone(body),
            headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
          },
          onCredentialsRefreshed: undefined,
          onRequestSuccess: undefined,
          onStreamFailure: undefined,
          onDisconnect: undefined,
          connectionId: undefined,
          userAgent: null,
          comboName: null,
        });
        assert.ok(!(result instanceof Response));
        assert.equal(result.success, false);
        assert.equal(result.status, 400);
        assert.equal(result.errorType, "invalid_request_error");
        assert.equal(dispatches, 0);
        assert.equal(shouldSkipConnDisable(result, false, false, "agy-enterprise"), true);
        assert.equal(shouldTripProviderBreakerForResult(result, false, false), false);
        const error = await result.response!.text();
        assert.match(
          error,
          invalid === "experience" ? /experience/i : invalid === "images" ? /media/i : /tool/i
        );
        assert.doesNotMatch(error, /\bat\s|\/private\/|[A-Z]:\\|response.completed/);
      });
    }

const upstreamFailure = {
  error: { code: 503, message: "Service unavailable\n    at /private/server.ts:1:1" },
};
const blockedFeedback = { promptFeedback: { blockReason: "SAFETY" } };
for (const endpoint of ["/v1/chat/completions", "/v1/responses"]) {
  for (const { description, events } of [
    {
      description: "text followed by an upstream error",
      events: [
        { candidates: [{ content: { parts: [{ text: "Partial answer" }] } }] },
        upstreamFailure,
      ],
    },
    {
      description: "direct error with blocked feedback",
      events: [{ ...upstreamFailure, ...blockedFeedback }],
    },
    {
      description: "wrapped error with blocked feedback",
      events: [{ response: { ...upstreamFailure, ...blockedFeedback } }],
    },
    {
      description: "direct blocked feedback followed by a wrapped error",
      events: [blockedFeedback, { response: upstreamFailure }],
    },
    {
      description: "wrapped blocked feedback followed by a wrapped error",
      events: [{ response: blockedFeedback }, { response: upstreamFailure }],
    },
  ]) {
    test(`AgyEnterprise ${endpoint} JSON rejects ${description}`, async (t) => {
      t.mock.method(
        globalThis,
        "fetch",
        async () =>
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "Content-Type": "text/event-stream" },
          })
      );
      const body = {
        model: "agy-enterprise/gemini-3.5-flash-lite",
        stream: false,
        ...(endpoint === "/v1/responses"
          ? { input: "Hello" }
          : { messages: [{ role: "user", content: "Hello" }] }),
      };
      const result = await handleChatCore({
        body,
        modelInfo: { provider: "agy-enterprise", model: "gemini-3.5-flash-lite" },
        credentials: {
          accessToken: "synthetic",
          providerSpecificData: { projectId: "project-one", location: "us", userTier: "standard" },
        },
        log,
        clientRawRequest: { endpoint, body, headers: new Headers({ accept: "application/json" }) },
        onCredentialsRefreshed: undefined,
        onRequestSuccess: undefined,
        onStreamFailure: undefined,
        onDisconnect: undefined,
        connectionId: undefined,
        userAgent: null,
        comboName: null,
      });
      assert.ok(!(result instanceof Response));
      assert.equal(result.success, false);
      assert.equal(result.response?.status, 502);
      const error = await result.response!.text();
      assert.match(error, /Service unavailable/);
      assert.doesNotMatch(
        error,
        /\bat\s|private\/server|Partial answer|response.completed|content_filter/
      );
    });
  }
}

for (const model of ["gemini-3.5-flash-lite", "gemini-3.8-flash-high", "custom-experience"])
  for (const responses of [false, true])
    for (const stream of [false, true]) {
      test(`Enterprise ${model} ${responses ? "Responses" : "Chat"} ${stream ? "SSE" : "JSON"} uses direct Gemini stream and preserves usage`, async (t) => {
        let dispatches = 0;
        t.mock.method(
          globalThis,
          "fetch",
          async (url: string | URL | Request, init?: RequestInit) => {
            dispatches++;
            assert.match(String(url), /businessaicode\.us\.rep\.googleapis\.com/);
            const sent = JSON.parse(String(init?.body));
            assert.equal(sent.aicode.experience, model);
            assert.equal(sent.entitlement.userTier, "standard");
            assert.equal("request" in sent, false);
            return new Response(
              `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }] })}\n\ndata: ${JSON.stringify(terminal)}\n\n`,
              { headers: { "Content-Type": "text/event-stream" } }
            );
          }
        );
        const body = {
          model: `agy-enterprise/${model}`,
          stream,
          ...(responses ? { input } : { messages: [{ role: "user", content: input }] }),
        };
        const result = await handleChatCore({
          body,
          modelInfo: { provider: "agy-enterprise", model },
          credentials: {
            accessToken: "synthetic",
            providerSpecificData: {
              projectId: "project-one",
              location: "us",
              userTier: "standard",
              oauthClient: "builtin",
            },
          },
          log,
          clientRawRequest: {
            endpoint: responses ? "/v1/responses" : "/v1/chat/completions",
            body: structuredClone(body),
            headers: new Headers({ accept: stream ? "text/event-stream" : "application/json" }),
          },
          onCredentialsRefreshed: undefined,
          onRequestSuccess: undefined,
          onStreamFailure: undefined,
          onDisconnect: undefined,
          connectionId: undefined,
          userAgent: null,
          comboName: null,
        });
        assert.ok(!(result instanceof Response));
        assert.equal(result.success, true, JSON.stringify(result));
        const response = result.response!;
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.match(text, /Hello/);
        assert.equal(dispatches, 1);
        if (stream) {
          assert.match(response.headers.get("Content-Type")!, /text\/event-stream/);
          assert.match(text, /12224/);
          if (responses) assert.match(text, /response.completed/);
          else assert.match(text, /"finish_reason":"stop"/);
        } else {
          const json = JSON.parse(text);
          const usage = json.usage;
          assert.equal(usage.total_tokens, 12224);
          assert.equal(responses ? usage.output_tokens : usage.completion_tokens, 84);
          if (responses) assert.equal(json.object, "response");
          else assert.equal(json.choices[0].finish_reason, "stop");
        }
      });
    }
