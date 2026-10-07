import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgyEnterpriseExecutor } from "../../open-sse/executors/agyEnterprise.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { parseSSEToGeminiResponse } from "../../open-sse/handlers/sseParser/geminiResponse.ts";
import { shouldSkipCredentialRefresh } from "../../open-sse/handlers/chatCore/skipCredentialRefresh.ts";
import { selectGoogleRefreshClient } from "../../open-sse/services/tokenRefresh/googleClientBinding.ts";
import { getAgyEnterpriseUsage } from "../../open-sse/services/usage/agyEnterprise.ts";
import { getUsageForProvider } from "../../open-sse/services/usage.ts";
import { isEmptyContentResponse } from "../../open-sse/services/errorClassifier.ts";
import { resetDbInstance } from "../../src/lib/db/core.ts";
import {
  toProviderLimitsCacheEntry,
  mergeProviderLimitsCacheEntry,
} from "../../src/lib/usage/providerLimitsCache.ts";

const context = { projectId: "project-one", location: "us", userTier: "standard" };
const credentials = {
  accessToken: "synthetic",
  providerSpecificData: { ...context, oauthClient: "builtin" },
  _provider: "agy-enterprise",
};
const model = "gemini-3.5-flash-lite";

test.after(() => resetDbInstance());

test("Enterprise invalid text-only input is a request failure without health penalties", async (t) => {
  const executor = new AgyEnterpriseExecutor();
  let refreshes = 0;
  let persistedRefreshes = 0;
  let dispatches = 0;
  t.mock.method(executor, "refreshCredentials", async () => {
    refreshes++;
    return { accessToken: "synthetic-refreshed" };
  });
  t.mock.method(globalThis, "fetch", async () => {
    dispatches++;
    return new Response(null, { status: 200 });
  });
  const result = await executor.execute({
    model,
    body: {
      contents: [{ parts: [{ text: "Hello" }] }],
      toolConfig: { functionCallingConfig: { mode: "ANY" } },
    },
    stream: false,
    credentials: { ...credentials, expiresAt: new Date(0).toISOString() },
    onCredentialsRefreshed: async () => {
      persistedRefreshes++;
    },
  });
  assert.equal(refreshes, 0);
  assert.equal(persistedRefreshes, 0);
  assert.equal(dispatches, 0);
  assert.ok(result instanceof Response);
  assert.equal(result.status, 400);
  const error = await result.json();
  assert.equal(error.error.type, "invalid_request_error");
  assert.match(error.error.message, /tool/i);
  assert.doesNotMatch(JSON.stringify(error), /\bat\s|\/private\/|[A-Z]:\\/);
});

test("Enterprise malformed requests and file images are local errors before dispatch", async (t) => {
  const executor = new AgyEnterpriseExecutor();
  let dispatches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    dispatches++;
    return new Response(null, { status: 200 });
  });
  for (const { body, diagnostic } of [
    { body: null, diagnostic: /Enterprise request/ },
    { body: { contents: [] }, diagnostic: /Enterprise request/ },
    {
      body: {
        contents: [{ parts: [{ fileData: { mimeType: "image/png", fileUri: "synthetic" } }] }],
      },
      diagnostic: /media/,
    },
    {
      body: {
        contents: [{ parts: [{ text: "Hello" }] }],
        systemInstruction: {
          parts: [{ inlineData: { mimeType: "image/png", data: "synthetic" } }],
        },
      },
      diagnostic: /Enterprise request/,
    },
    {
      body: {
        contents: [{ parts: [{ text: "Hello" }] }],
        toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      },
      diagnostic: /tool/,
    },
  ]) {
    const result = await executor.execute({ model, body, stream: false, credentials });
    assert.ok(result instanceof Response);
    assert.equal(result.status, 400);
    const error = await result.json();
    assert.equal(error.error.type, "invalid_request_error");
    assert.match(error.error.message, diagnostic);
  }
  assert.equal(dispatches, 0);
});

test("Enterprise credential context and dispatch failures remain outside request validation", async (t) => {
  const executor = new AgyEnterpriseExecutor();
  const body = { contents: [{ parts: [{ text: "Hello" }] }] };
  await assert.rejects(
    executor.execute({ model, body, stream: false, credentials: { accessToken: "synthetic" } })
  );
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("synthetic dispatch failure");
  });
  await assert.rejects(
    executor.execute({ model, body, stream: false, credentials }),
    /synthetic dispatch failure/
  );
});

test("Enterprise terminal-only completion is valid and never becomes a synthetic failure", () => {
  assert.equal(
    isEmptyContentResponse(
      { choices: [{ message: { role: "assistant", content: null }, finish_reason: "stop" }] },
      { provider: "agy-enterprise" }
    ),
    false
  );
});

test("registry selects Enterprise executor and OpenAI text remains root Gemini without personal defaults", async () => {
  const executor = await getExecutor("agy-enterprise");
  assert.ok(executor instanceof AgyEnterpriseExecutor);
  const translated = openaiToGeminiRequest(
    model,
    {
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 123,
      temperature: 0.4,
    },
    false,
    credentials
  );
  const body = executor.transformRequest(
    model,
    {
      ...translated,
      aicode: { experience: "injected" },
      entitlement: { userTier: "injected" },
      project: "injected",
    },
    false,
    credentials
  );
  assert.equal(body.aicode.experience, model);
  assert.equal(body.entitlement.userTier, "standard");
  assert.equal(body.systemInstruction?.parts[0].text, "Be brief");
  assert.equal(body.generationConfig?.maxOutputTokens, 123);
  assert.equal(body.generationConfig?.temperature, 0.4);
  assert.equal(body.generationConfig?.thinkingConfig, undefined);
  assert.equal("request" in body, false);
  assert.equal("project" in body, false);
  assert.equal("safetySettings" in body, false);
  assert.match(
    executor.buildUrl(model, false, 0, credentials),
    /^https:\/\/businessaicode\.us\.rep\.googleapis\.com\/v1beta\/projects\/project-one\/locations\/us:streamGenerateContent\?alt=sse$/
  );
  assert.equal(
    executor.buildUrl(model, true, 0, {
      ...credentials,
      providerSpecificData: { ...context, location: "eu" },
    }),
    "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/project-one/locations/eu:streamGenerateContent?alt=sse"
  );
  assert.throws(() =>
    executor.buildUrl(model, true, 0, {
      ...credentials,
      providerSpecificData: { ...context, location: "global" },
    })
  );
  for (const experience of ["gemini-3.8-flash-high", "custom-experience"]) {
    assert.equal(
      executor.transformRequest(experience, translated, false, credentials).aicode.experience,
      experience
    );
  }
  for (const invalid of ["", " ", "x".repeat(201)])
    assert.throws(() => executor.transformRequest(invalid, translated, false, credentials));
  assert.throws(() =>
    executor.transformRequest(
      "custom-experience",
      {
        contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "synthetic" } }] }],
      },
      false,
      credentials
    )
  );
  assert.throws(
    () =>
      executor.transformRequest(
        model,
        { ...translated, tools: [{ functionDeclarations: [] }] },
        true,
        credentials
      ),
    /Too small/
  );
});

test("upstream always streams; caller context cannot override stored context", async (t) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]},"finishReason":"STOP"}]}\n\n',
      { headers: { "Content-Type": "text/event-stream" } }
    );
  });
  const executor = new AgyEnterpriseExecutor();
  await executor.execute({
    model,
    body: {
      contents: [{ role: "user", parts: [{ text: "Hi" }] }],
      projectId: "attack-project",
      location: "eu",
    },
    stream: false,
    credentials,
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /projects\/project-one\/locations\/us/);
  const sent = JSON.parse(String(calls[0].init?.body));
  assert.equal(sent.aicode.experience, model);
  assert.equal("projectId" in sent, false);
  assert.match(
    new Headers(calls[0].init?.headers).get("X-Aicode-Request-Id")!,
    /^checkpoint\/[a-f0-9-]+$/
  );
});

test("direct and wrapped terminal-only SSE preserve finish and count reasoning once", () => {
  const terminal = JSON.parse(
    readFileSync(new URL("../fixtures/agy-enterprise/terminal.json", import.meta.url), "utf8")
  );
  for (const data of [terminal, { response: terminal }]) {
    const result = parseSSEToGeminiResponse(`data: ${JSON.stringify(data)}\n\n`, model)!;
    assert.deepEqual(result.usage, {
      prompt_tokens: 12140,
      completion_tokens: 84,
      total_tokens: 12224,
      completion_tokens_details: { reasoning_tokens: 45 },
    });
    assert.equal((result.choices as { finish_reason: string }[])[0].finish_reason, "stop");
  }
});

test("Gemini buffered prompt safety blocks preserve filtered termination", async (t) => {
  const terminal = JSON.parse(
    readFileSync(new URL("../fixtures/agy-enterprise/terminal.json", import.meta.url), "utf8")
  );
  for (const wrapped of [false, true]) {
    for (const withUsage of [false, true]) {
      await t.test(
        `${wrapped ? "wrapped" : "direct"}, ${withUsage ? "with" : "without"} usage`,
        () => {
          const feedback = {
            promptFeedback: { blockReason: "SAFETY" },
            ...(withUsage ? { usageMetadata: terminal.usageMetadata } : {}),
          };
          const event = wrapped ? { response: feedback } : feedback;
          const parsed = parseSSEToGeminiResponse(`data: ${JSON.stringify(event)}\n\n`, model);
          assert.ok(parsed, "prompt safety blocks are valid terminal responses without usage");
          const choices = parsed.choices as {
            finish_reason: string;
            message: { content: string | null };
          }[];
          assert.equal(choices[0].finish_reason, "content_filter");
          assert.equal(choices[0].message.content, null);
          if (withUsage)
            assert.equal((parsed.usage as { total_tokens: number }).total_tokens, 12224);
          else assert.equal(parsed.usage, undefined);
        }
      );
    }
  }
});

test("Enterprise permission failures do not refresh; issuer binding fails closed", async () => {
  assert.equal(
    await shouldSkipCredentialRefresh("agy-enterprise", new Response(null, { status: 403 })),
    true
  );
  assert.equal(
    await shouldSkipCredentialRefresh("agy-enterprise", new Response(null, { status: 401 })),
    false
  );
  assert.throws(
    () => selectGoogleRefreshClient("agy-enterprise", "builtin", {}),
    /issuing OAuth client/
  );
  assert.throws(
    () =>
      selectGoogleRefreshClient("agy-enterprise", "custom:old", {
        clientId: "new",
        clientSecret: "secret",
      }),
    /issuing OAuth client/
  );
  assert.throws(
    () => selectGoogleRefreshClient("agy-enterprise", undefined, {}),
    /issuing OAuth client/
  );
});

test("quota observations retain raw fractions, unknowns and provenance without authoritative quota", async (t) => {
  let payload: unknown;
  let summaryCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
    assert.equal(
      String(url),
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
    );
    assert.equal(init?.body, "{}");
    summaryCalls++;
    return Response.json(payload);
  });
  payload = {
    groups: [
      {
        buckets: [
          { bucketId: "gemini-3.8-flash-high", remainingFraction: 1 },
          { bucketId: "unknown-window" },
        ],
      },
    ],
  };
  const usage = await getUsageForProvider(
    { provider: "agy-enterprise", accessToken: "synthetic", providerSpecificData: context },
    { forceRefresh: true }
  );
  assert.equal(summaryCalls, 1, "explicit dashboard refresh still fetches advisory observations");
  assert.equal(usage.quotas, null);
  assert.equal(usage.quotaObservations?.authority, "advisory");
  assert.equal(usage.quotaObservations?.buckets[0].remainingFraction, 1);
  assert.equal(usage.quotaObservations?.buckets[1].remainingFraction, undefined);
  const cache = toProviderLimitsCacheEntry(usage, "manual");
  const error = toProviderLimitsCacheEntry({ quotas: null, message: "failed" }, "manual");
  assert.equal(mergeProviderLimitsCacheEntry("agy-enterprise", error, cache), cache);
  payload = { groups: [{ buckets: [{ bucketId: "bad", remainingFraction: 2 }] }] };
  assert.equal((await getAgyEnterpriseUsage("synthetic", context)).quotaObservations, undefined);
});
