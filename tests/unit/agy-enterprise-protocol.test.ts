import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleChatCore } from "../../open-sse/handlers/chatCore.ts";

const model = "gemini-3.5-flash-lite";
const terminal = JSON.parse(
  readFileSync(new URL("../fixtures/agy-enterprise/terminal.json", import.meta.url), "utf8")
);
const log = { debug() {}, info() {}, warn() {}, error() {} };
// Synthetic context makes the captured 12,140-token usage physically plausible.
// The private CLI harness was not recoverable from screenshots.
const input = "Synthetic context. ".repeat(3000) + "Hello";

for (const responses of [false, true])
  for (const stream of [false, true]) {
    test(`Enterprise ${responses ? "Responses" : "Chat"} ${stream ? "SSE" : "JSON"} uses direct Gemini stream and preserves usage`, async (t) => {
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
