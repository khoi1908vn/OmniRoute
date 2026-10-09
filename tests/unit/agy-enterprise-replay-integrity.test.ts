import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import * as store from "../../open-sse/services/geminiThoughtSignatureStore.ts";
import { getDbInstance, resetDbInstance } from "../../src/lib/db/core.ts";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.ts";
import { geminiToClaudeResponse } from "../../open-sse/translator/response/gemini-to-claude.ts";
import { openaiToGeminiRequest } from "../../open-sse/translator/request/openai-to-gemini.ts";
import { claudeToGeminiRequest } from "../../open-sse/translator/request/claude-to-gemini.ts";
import { parseSSEToGeminiResponse } from "../../open-sse/handlers/sseParser/geminiResponse.ts";
import { translateRequest } from "../../open-sse/translator/index.ts";
import { translateNonStreamingResponse } from "../../open-sse/handlers/responseTranslator.ts";
import { AgyEnterpriseExecutor } from "../../open-sse/executors/agyEnterprise.ts";

const model = "gemini-3.8-flash-high";
const namespace = store.buildAgyEnterpriseReplayNamespace("integrity", model);
const credentials = { _provider: "agy-enterprise", _signatureNamespace: "integrity" };
const history = [{ role: "user", parts: [{ text: "hello" }] }];
const event = (parts: Array<Record<string, unknown>>) => ({
  candidates: [{ content: { parts }, finishReason: "STOP" }],
});
const state = () => ({
  provider: "agy-enterprise",
  signatureNamespace: namespace,
  enterpriseReplayHistory: history,
  toolCalls: new Map(),
});
const call = { id: "stable", name: "read", args: { path: "synthetic" } };
const signed = { functionCall: call, thoughtSignature: "c2ln" };
const toolHistory = (args = call.args, name = call.name) => ({
  messages: [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      tool_calls: [
        { id: call.id, type: "function", function: { name, arguments: JSON.stringify(args) } },
      ],
    },
  ],
});
test.after(() => resetDbInstance());

test("Teammate fallback rejects malformed persisted lifetimes", () => {
  for (const expiry of [undefined, null, "expired", -1]) {
    store.clearGeminiThoughtSignatures();
    store.storeAgyEnterpriseTextSignature(namespace, "Lifetime report.", "c2ln", teammateOrigin);
    const db = getDbInstance();
    const row = db
      .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
      .get("gemini_thought_signatures") as { key: string; value: string };
    db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
      JSON.stringify({ ...JSON.parse(row.value), expiresAt: expiry }),
      "gemini_thought_signatures",
      row.key
    );
    store.clearGeminiThoughtSignatureMemoryForTests();
    assert.equal(
      store.getAgyEnterpriseTextReplay(namespace, "Lifetime report.", [], teammateRebuilt),
      null
    );
  }
});

test("Teammate fallback cannot strip captured calls, media, or grounding", () => {
  for (const translateResponse of [geminiToClaudeResponse, geminiToOpenAIResponse]) {
    for (const extra of [
      signed,
      { inlineData: { mimeType: "image/png", data: "AA==" } },
      { fileData: { fileUri: "synthetic" } },
      null,
    ]) {
      for (const signature of ["c2ln", undefined]) {
        store.clearGeminiThoughtSignatures();
        const text = "Bound report.";
        const candidate = {
          content: {
            parts: [
              { text, ...(signature ? { thoughtSignature: signature } : {}) },
              ...(extra ? [extra] : []),
            ],
          },
          finishReason: "STOP",
          ...(!extra ? { groundingMetadata: { webSearchQueries: ["synthetic query"] } } : {}),
        };
        translateResponse(
          { candidates: [candidate] },
          { ...state(), enterpriseReplayHistory: teammateOrigin }
        );
        assert.equal(
          store.getAgyEnterpriseTextReplay(namespace, text, [], teammateRebuilt),
          null,
          JSON.stringify(extra)
        );
        for (const translate of [claudeToGeminiRequest, openaiToGeminiRequest]) {
          assert.throws(
            () =>
              translate(
                model,
                {
                  messages: [
                    { role: "user", content: "hello" },
                    { role: "user", content: teammateRebuilt[1].parts[0].text },
                    { role: "assistant", content: text },
                  ],
                },
                false,
                credentials
              ),
            /replay/
          );
        }
      }
    }
  }
});

test("Instruction removal preserves uniquely scoped old call origins", () => {
  store.clearGeminiThoughtSignatures();
  const oldHistory = [...history, { role: "user", parts: [{ text: "Harness context only." }] }];
  const sibling = { ...call, id: "instruction-sibling", args: { path: "second" } };
  const originalParts = [signed, { functionCall: sibling }];
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: oldHistory },
    originalParts,
    true
  );
  const body = {
    messages: [
      { role: "user", content: "hello" },
      { role: "system", content: "Harness context only." },
      {
        role: "assistant",
        content: [call, sibling].map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.args,
        })),
      },
      {
        role: "user",
        content: [call, sibling].map((c) => ({
          type: "tool_result",
          tool_use_id: c.id,
          content: "found",
        })),
      },
    ],
  };
  const result = claudeToGeminiRequest(model, body, false, credentials);
  assert.deepEqual(result.systemInstruction, {
    role: "user",
    parts: [{ text: "Harness context only." }],
  });
  assert.deepEqual(result.contents[0], history[0]);
  assert.deepEqual(result.contents[1], { role: "model", parts: originalParts });
  assert.ok(!JSON.stringify(result.contents).includes("Harness context only."));
  assert.throws(
    () =>
      claudeToGeminiRequest(model, body, false, {
        ...credentials,
        _signatureNamespace: "different-account",
      }),
    /replay/
  );
  assert.throws(
    () => claudeToGeminiRequest("gemini-3.8-flash-low", body, false, credentials),
    /replay/
  );
  body.messages[2].content[0].input = { path: "altered" };
  assert.throws(() => claudeToGeminiRequest(model, body, false, credentials), /replay/);
});

test("Standalone text rejects history changed by instruction removal", () => {
  store.clearGeminiThoughtSignatures();
  const oldHistory = [...history, { role: "user", parts: [{ text: "Harness context only." }] }];
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: oldHistory },
    [{ text: "Original answer.", thoughtSignature: "dGV4dA==" }],
    true
  );
  const body = {
    messages: [
      { role: "user", content: "hello" },
      { role: "system", content: "Harness context only." },
      { role: "assistant", content: "Original answer." },
    ],
  };
  assert.throws(() => claudeToGeminiRequest(model, body, false, credentials), /replay/);
  assert.equal(store.getAgyEnterpriseTextSignature(namespace, "Original answer.", history), null);
  assert.equal(
    store.getAgyEnterpriseTextSignature(namespace, "Original answer.", oldHistory),
    "dGV4dA=="
  );
});

test("Ordinary text origins survive a teammate final-user rebuild", () => {
  store.clearGeminiThoughtSignatures();
  const text = "The exploration is complete.";
  const signature = "dGV4dA==";
  const teammateText =
    'Another Claude session sent a message: <teammate-message teammate_id="explorer">Report</teammate-message>\n';
  const originHistory = [
    ...history,
    { role: "user", parts: [{ text: "Parent asks for current progress." }] },
  ];
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: originHistory },
    [{ text, thoughtSignature: signature }],
    true
  );
  const rebuiltTeammateHistory = [
    ...history,
    { role: "user", parts: [{ text: teammateText.slice(0, -1) }] },
  ];
  assert.deepEqual(store.getAgyEnterpriseTextReplay(namespace, text, [], rebuiltTeammateHistory), {
    thoughtSignature: signature,
  });
  const translated = claudeToGeminiRequest(
    model,
    {
      messages: [
        { role: "user", content: "hello" },
        { role: "user", content: teammateText.slice(0, -1) },
        { role: "assistant", content: text },
      ],
    },
    false,
    credentials
  );
  assert.deepEqual(translated.contents.at(-1)?.parts, [{ text, thoughtSignature: signature }]);
  assert.equal(
    store.getAgyEnterpriseTextReplay(
      namespace,
      text,
      [],
      [{ role: "user", parts: [{ text: "Changed original prompt." }] }, rebuiltTeammateHistory[1]]
    ),
    null
  );
  const unsignedText = "The team report is complete.";
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: originHistory },
    [{ text: unsignedText }],
    true,
    "STOP"
  );
  assert.deepEqual(
    store.getAgyEnterpriseTextReplay(namespace, unsignedText, [], rebuiltTeammateHistory),
    {}
  );
  store.storeAgyEnterpriseTextSignature(namespace, text, "b3RoZXI=", [
    ...history,
    { role: "user", parts: [{ text: teammateText + "another message" }] },
  ]);
  assert.equal(store.getAgyEnterpriseTextReplay(namespace, text, [], rebuiltTeammateHistory), null);
});

const teammateOrigin = [
  ...history,
  { role: "user", parts: [{ text: "Parent asks for current progress." }] },
];
const teammateRebuilt = [
  ...history,
  {
    role: "user",
    parts: [{ text: '<teammate-message teammate_id="explorer">Report</teammate-message>' }],
  },
];

test("Teammate standalone recovery retains namespace, identity, and context guards", () => {
  store.clearGeminiThoughtSignatures();
  const text = "The exploration is complete.";
  store.storeAgyEnterpriseTextSignature(namespace, text, "dGV4dA==", teammateOrigin);
  assert.deepEqual(store.getAgyEnterpriseTextReplay(namespace, text, [], teammateRebuilt), {
    thoughtSignature: "dGV4dA==",
  });
  assert.equal(store.getAgyEnterpriseTextReplay(namespace, text + "!", [], teammateRebuilt), null);
  for (const invalid of [
    [{ role: "user", parts: [{ text: "changed earlier prompt" }] }, teammateRebuilt[1]],
    [...history, { role: "user", parts: [{ text: "unrelated replacement" }] }],
  ]) {
    assert.equal(store.getAgyEnterpriseTextReplay(namespace, text, [], invalid), null);
  }
  for (const other of [
    store.buildAgyEnterpriseReplayNamespace("other-connection", model),
    store.buildAgyEnterpriseReplayNamespace("integrity", "gemini-3.8-flash-low"),
  ]) {
    assert.equal(store.getAgyEnterpriseTextReplay(other, text, [], teammateRebuilt), null);
  }
  assert.equal(store.getAgyEnterpriseTextReplay(namespace, text, [call], teammateRebuilt), null);
});

test("Teammate text recovery never bypasses invalid or ambiguous persisted origins", () => {
  const text = "The exploration is complete.";
  for (const invalid of [
    "expired-exact",
    "malformed",
    "conflicting-exact",
    "duplicate",
    "legacy",
  ]) {
    store.clearGeminiThoughtSignatures();
    store.storeAgyEnterpriseTextSignature(namespace, text, "dGV4dA==", teammateOrigin);
    const db = getDbInstance();
    const row = db
      .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
      .get("gemini_thought_signatures") as { key: string; value: string };
    const entry = JSON.parse(row.value);
    if (invalid === "duplicate") {
      store.storeAgyEnterpriseTextSignature(namespace, text, "dGV4dA==", [
        ...history,
        { role: "user", parts: [{ text: "another origin" }] },
      ]);
    } else if (invalid.endsWith("exact")) {
      const exactKey = row.key.replace(
        store.agyEnterpriseReplayHistoryDigest(teammateOrigin),
        store.agyEnterpriseReplayHistoryDigest(teammateRebuilt)
      );
      db.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)").run(
        "gemini_thought_signatures",
        exactKey,
        JSON.stringify(
          invalid === "expired-exact"
            ? { ...entry, expiresAt: 1 }
            : {
                ...entry,
                signature: "!ambiguous-enterprise-text!",
              }
        )
      );
    } else {
      db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
        JSON.stringify({ ...entry, signature: invalid === "legacy" ? "dGV4dA==" : "{malformed" }),
        "gemini_thought_signatures",
        row.key
      );
    }
    store.clearGeminiThoughtSignatureMemoryForTests();
    assert.equal(
      store.getAgyEnterpriseTextReplay(namespace, text, [], teammateRebuilt),
      null,
      invalid
    );
    if (invalid === "legacy") {
      assert.deepEqual(store.getAgyEnterpriseTextReplay(namespace, text, [], teammateOrigin), {
        thoughtSignature: "dGV4dA==",
      });
      db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
        JSON.stringify({ ...entry, signature: JSON.stringify({ kind: "native-unsigned-text" }) }),
        "gemini_thought_signatures",
        row.key
      );
      store.clearGeminiThoughtSignatureMemoryForTests();
      assert.deepEqual(store.getAgyEnterpriseTextReplay(namespace, text, [], teammateOrigin), {});
      assert.equal(store.getAgyEnterpriseTextReplay(namespace, text, [], teammateRebuilt), null);
    }
  }
});

test("Teammate context origins survive memory and database reopening", () => {
  store.clearGeminiThoughtSignatures();
  const text = "The exploration is complete.";
  const unsignedText = "The team report is complete.";
  store.storeAgyEnterpriseTextSignature(namespace, text, "dGV4dA==", teammateOrigin);
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: teammateOrigin },
    [{ text: unsignedText }],
    true,
    "STOP"
  );
  store.clearGeminiThoughtSignatureMemoryForTests();
  resetDbInstance();
  assert.deepEqual(store.getAgyEnterpriseTextReplay(namespace, text, [], teammateRebuilt), {
    thoughtSignature: "dGV4dA==",
  });
  assert.deepEqual(
    store.getAgyEnterpriseTextReplay(namespace, unsignedText, [], teammateRebuilt),
    {}
  );
});

test("Claude and OpenAI teammate replay preserve native standalone parts", () => {
  store.clearGeminiThoughtSignatures();
  const text = "The exploration is complete.";
  const unsignedText = "The team report is complete.";
  store.storeAgyEnterpriseTextSignature(namespace, text, "dGV4dA==", teammateOrigin);
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: teammateOrigin },
    [{ text: unsignedText }],
    true,
    "STOP"
  );
  for (const translate of [claudeToGeminiRequest, openaiToGeminiRequest]) {
    for (const [reply, parts] of [
      [text, [{ text, thoughtSignature: "dGV4dA==" }]],
      [unsignedText, [{ text: unsignedText }]],
    ] as const) {
      const body = {
        messages: [
          { role: "user", content: "hello" },
          { role: "user", content: teammateRebuilt[1].parts[0].text },
          { role: "assistant", content: reply },
        ],
      };
      const result = translate(model, body, false, credentials);
      assert.deepEqual(result.contents.at(-1)?.parts, parts);
      body.messages[0].content = "changed earlier prompt";
      assert.throws(() => translate(model, body, false, credentials), /replay/);
    }
  }
});

test("Diagnostic flags never bypass Enterprise replay rejection", () => {
  store.clearGeminiThoughtSignatures();
  const previous = process.env.OMNIROUTE_ENTERPRISE_REPLAY_DIAGNOSTIC_CONTINUE;
  process.env.OMNIROUTE_ENTERPRISE_REPLAY_DIAGNOSTIC_CONTINUE = "true";
  try {
    for (const translate of [claudeToGeminiRequest, openaiToGeminiRequest]) {
      assert.throws(
        () =>
          translate(
            model,
            {
              messages: [
                { role: "user", content: "hello" },
                { role: "assistant", content: "Unrecorded answer." },
              ],
            },
            false,
            credentials
          ),
        /Enterprise replay rejected/
      );
      const tools =
        translate === claudeToGeminiRequest
          ? {
              messages: [
                { role: "user", content: "hello" },
                {
                  role: "assistant",
                  content: [{ type: "tool_use", id: call.id, name: call.name, input: call.args }],
                },
              ],
            }
          : toolHistory();
      assert.throws(
        () => translate(model, tools, false, credentials),
        /Enterprise replay rejected/
      );
    }
  } finally {
    if (previous === undefined) delete process.env.OMNIROUTE_ENTERPRISE_REPLAY_DIAGNOSTIC_CONTINUE;
    else process.env.OMNIROUTE_ENTERPRISE_REPLAY_DIAGNOSTIC_CONTINUE = previous;
  }
});

test("Resumed teammates replay immutable call groups after their hook prefix is rebuilt", () => {
  store.clearGeminiThoughtSignatures();
  const originalHistory = [
    { role: "user", parts: [{ text: "task\n" }, { text: "initial reminder" }] },
    { role: "user", parts: [{ text: "initial hook context" }] },
  ];
  const calls = [call, { ...call, id: "resume-sibling", args: { path: "second" } }];
  store.captureAgyEnterpriseReplayParts(
    { ...state(), enterpriseReplayHistory: originalHistory },
    [
      { text: "Looking up files." },
      { functionCall: calls[0], thoughtSignature: "c2ln" },
      { functionCall: calls[1] },
    ],
    true
  );
  const body = {
    messages: [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking up files." },
          ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
        ],
      },
      {
        role: "user",
        content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "found" })),
      },
      { role: "user", content: "teammate mailbox message" },
    ],
  };
  const native = claudeToGeminiRequest(model, body, false, credentials);
  assert.deepEqual(native.contents[1].parts, [
    { text: "Looking up files." },
    { functionCall: calls[0], thoughtSignature: "c2ln" },
    { functionCall: calls[1] },
  ]);
  assert.equal(native.contents[0].parts[0].text, "task");
  const openai = {
    messages: [
      { role: "user", content: "task" },
      {
        role: "assistant",
        content: "Looking up files.",
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
    ],
  };
  assert.doesNotThrow(() => openaiToGeminiRequest(model, openai, false, credentials));
  assert.throws(
    () =>
      claudeToGeminiRequest(model, body, false, {
        ...credentials,
        _signatureNamespace: "different-account",
      }),
    /replay/
  );
  assert.throws(
    () => claudeToGeminiRequest("gemini-3.8-flash-low", body, false, credentials),
    /replay/
  );
  body.messages[1].content[1].input = { path: "altered" };
  assert.throws(() => claudeToGeminiRequest(model, body, false, credentials), /replay/);
});

test("Rebuilt histories reject call IDs captured in multiple origin histories", () => {
  store.clearGeminiThoughtSignatures();
  store.storeAgyEnterpriseCallSignature(namespace, call, "c2ln", history);
  store.storeAgyEnterpriseCallSignature(namespace, call, "b3RoZXI=", [
    { role: "user", parts: [{ text: "second origin" }] },
  ]);
  assert.equal(
    store.getAgyEnterpriseCallSignature(namespace, call, [
      { role: "user", parts: [{ text: "rebuilt prefix" }] },
    ]),
    null
  );
  assert.match(
    store.describeAgyEnterpriseReplayFailure(namespace, "call", call.id, [
      { role: "user", parts: [{ text: "rebuilt prefix" }] },
    ]),
    /reason=ambiguous_origin.*originRecords=2/
  );
});

test("Enterprise schema errors expose failing paths and validation codes", async () => {
  const result = await new AgyEnterpriseExecutor().execute({
    model,
    body: { contents: [] },
    stream: false,
    credentials: {
      accessToken: "synthetic",
      providerSpecificData: { projectId: "synthetic", location: "us", userTier: "standard" },
    },
  });
  const response = result instanceof Response ? result : result.response;
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error.message, /contents/);
  assert.match(body.error.message, /too_small/);
});

test("Buffered Claude tool-only responses do not invent replayable assistant text", () => {
  const translated = translateNonStreamingResponse(
    {
      object: "chat.completion",
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    "openai",
    "claude"
  );
  assert.deepEqual(
    translated.content.map((part) => part.type),
    ["tool_use"]
  );
});

test("Enterprise replays observed parallel calls with only the first call signed", () => {
  store.clearGeminiThoughtSignatures();
  const calls = [
    call,
    { ...call, id: "sibling-2", args: { path: "two" } },
    { ...call, id: "sibling-3", args: { path: "three" } },
  ];
  geminiToClaudeResponse(
    event([
      { text: "Searching files." },
      ...calls.map((functionCall, index) => ({
        functionCall,
        ...(index === 0 ? { thoughtSignature: "c2ln" } : {}),
      })),
      { text: "" },
    ]),
    state()
  );
  const body = {
    messages: [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching files." },
          ...calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
        ],
      },
      {
        role: "user",
        content: calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "found" })),
      },
    ],
  };
  const native = claudeToGeminiRequest(model, body, false, credentials);
  const replayed = native.contents[1].parts.filter((p) => "functionCall" in p);
  assert.deepEqual(
    replayed.map((p) => p.thoughtSignature),
    ["c2ln", undefined, undefined]
  );
  const openai = openaiToGeminiRequest(
    model,
    {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "Searching files.",
          tool_calls: calls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
      ],
    },
    false,
    credentials
  );
  assert.deepEqual(
    openai.contents[1].parts.filter((p) => "functionCall" in p).map((p) => p.thoughtSignature),
    ["c2ln", undefined, undefined]
  );
  for (const invalidCalls of [
    calls.slice(1),
    [...calls].reverse(),
    [calls[0], { ...calls[1], args: { path: "changed" } }, calls[2]],
  ]) {
    assert.throws(
      () =>
        claudeToGeminiRequest(
          model,
          {
            messages: [
              body.messages[0],
              {
                role: "assistant",
                content: invalidCalls.map((c) => ({
                  type: "tool_use",
                  id: c.id,
                  name: c.name,
                  input: c.args,
                })),
              },
            ],
          },
          false,
          credentials
        ),
      /replay/
    );
  }
});

test("Enterprise replay errors identify lookup kind and history without signature bytes", () => {
  store.clearGeminiThoughtSignatures();
  assert.throws(
    () => openaiToGeminiRequest(model, toolHistory(), false, credentials),
    (error) => {
      const message = (error as Error).message;
      assert.match(message, /kind=call/);
      assert.match(message, /reason=missing/);
      assert.match(message, /history=[a-f0-9]{64}/);
      assert.match(message, /id=stable/);
      assert.ok(!message.includes("c2ln"));
      return true;
    }
  );
});

test("Enterprise rejects changed native call identity before translation and conflicting recapture", () => {
  store.clearGeminiThoughtSignatures();
  geminiToOpenAIResponse(event([signed]), state());
  assert.doesNotThrow(() => openaiToGeminiRequest(model, toolHistory(), false, credentials));
  for (const body of [toolHistory({ path: "changed" }), toolHistory(call.args, "write")])
    assert.throws(() => openaiToGeminiRequest(model, body, false, credentials), /replay/);
  assert.throws(
    () =>
      claudeToGeminiRequest(
        model,
        {
          messages: [
            { role: "user", content: "hello" },
            {
              role: "assistant",
              content: [{ type: "tool_use", id: call.id, name: "write", input: call.args }],
            },
          ],
        },
        false,
        credentials
      ),
    /replay/
  );
  geminiToOpenAIResponse(event([{ ...signed, thoughtSignature: "b3RoZXI=" }]), state());
  assert.throws(() => openaiToGeminiRequest(model, toolHistory(), false, credentials), /replay/);
});

test("Enterprise text replay binds history and rejects duplicate or altered turn association", () => {
  store.clearGeminiThoughtSignatures();
  geminiToOpenAIResponse(event([{ text: "hello world", thoughtSignature: "c2ln" }]), state());
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hello world" },
  ];
  assert.doesNotThrow(() => openaiToGeminiRequest(model, { messages }, false, credentials));
  assert.throws(
    () =>
      openaiToGeminiRequest(
        model,
        {
          messages: [
            ...messages,
            { role: "user", content: "next" },
            { role: "assistant", content: "hello world" },
          ],
        },
        false,
        credentials
      ),
    /replay/
  );
  assert.throws(
    () =>
      openaiToGeminiRequest(
        model,
        { messages: [{ role: "user", content: "changed" }, messages[1]] },
        false,
        credentials
      ),
    /replay/
  );
  const db = getDbInstance();
  const row = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ? AND key LIKE ?")
    .get("gemini_thought_signatures", "agy-enterprise:%") as { key: string; value: string };
  const entry = JSON.parse(row.value);
  db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
    JSON.stringify({ ...entry, signature: "!ambiguous-enterprise-text!" }),
    "gemini_thought_signatures",
    row.key
  );
  assert.throws(() => openaiToGeminiRequest(model, { messages }, false, credentials), /replay/);
});

test("Enterprise multipart Claude text emits exact concatenation with one signature", () => {
  store.clearGeminiThoughtSignatures();
  geminiToClaudeResponse(event([{ text: "hello world", thoughtSignature: "c2ln" }]), state());
  const result = claudeToGeminiRequest(
    model,
    {
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      ],
    },
    false,
    credentials
  );
  assert.deepEqual(result.contents[1].parts, [{ text: "hello world", thoughtSignature: "c2ln" }]);
});

test("Enterprise explicitly signed visible text beside native calls survives continuation", () => {
  for (const convert of [geminiToOpenAIResponse, geminiToClaudeResponse]) {
    store.clearGeminiThoughtSignatures();
    convert(event([{ text: "reading", thoughtSignature: "dGV4dA==" }, signed]), state());
    const body = toolHistory();
    body.messages[1].content = "reading";
    const result = openaiToGeminiRequest(model, body, false, credentials);
    assert.equal(result.contents[1].parts[0].thoughtSignature, "dGV4dA==");
    assert.equal(result.contents[1].parts[1].thoughtSignature, "c2ln");
  }
});

test("Enterprise validates original Responses tool choice even without declarations", () => {
  assert.throws(
    () =>
      translateRequest(
        "openai-responses",
        "gemini",
        model,
        { input: "hi", tool_choice: "none" },
        false,
        credentials,
        "agy-enterprise"
      ),
    /unverified tool mode/
  );
});

test("Enterprise visible tool syntax stays literal in streamed and buffered formats", () => {
  for (const text of [
    '[Tool call: read({"path":"synthetic"})]',
    '<invoke name="read"><parameter name="path">synthetic</parameter></invoke>',
    'TOOL_CALL read({"path":"synthetic"})',
  ]) {
    for (const convert of [geminiToOpenAIResponse, geminiToClaudeResponse]) {
      const result = convert(event([{ text, thoughtSignature: "dGV4dA==" }]), state());
      const json = JSON.stringify(result);
      assert.ok(!json.includes('"type":"tool_use"') && !json.includes('"tool_calls"'), json);
      assert.ok(json.includes(JSON.stringify(text).slice(1, -1)), json);
    }
    const result = parseSSEToGeminiResponse(
      `data: ${JSON.stringify(event([{ text }]))}\n\n`,
      model,
      { provider: "agy-enterprise", connectionId: "integrity", experience: model }
    );
    assert.equal(result.choices[0].message.content, text);
    assert.equal(result.choices[0].message.tool_calls, undefined);
  }
});

test("Enterprise expired history cannot be rebound to a new signature", () => {
  store.clearGeminiThoughtSignatures();
  geminiToOpenAIResponse(event([{ text: "old", thoughtSignature: "b2xk" }]), state());
  const db = getDbInstance();
  const row = db
    .prepare("SELECT key, value FROM key_value WHERE namespace = ?")
    .get("gemini_thought_signatures") as { key: string; value: string };
  db.prepare("UPDATE key_value SET value = ? WHERE namespace = ? AND key = ?").run(
    JSON.stringify({ ...JSON.parse(row.value), expiresAt: 1 }),
    "gemini_thought_signatures",
    row.key
  );
  geminiToOpenAIResponse(event([{ text: "old", thoughtSignature: "bmV3" }]), state());
  assert.equal(store.getAgyEnterpriseTextSignature(namespace, "old", history), null);
});

test("Enterprise replays observed unsigned pre-call text without borrowing a signature", () => {
  for (const convert of [geminiToOpenAIResponse, geminiToClaudeResponse]) {
    store.clearGeminiThoughtSignatures();
    const reply = event([
      { text: "Checking the files." },
      signed,
      { text: "", thoughtSignature: "dGFpbA==" },
    ]);
    convert(reply, state());
    const body = toolHistory();
    body.messages[1].content = "Checking the files.";
    const openai = openaiToGeminiRequest(model, body, false, credentials);
    const claude = claudeToGeminiRequest(
      model,
      {
        messages: [
          body.messages[0],
          {
            role: "assistant",
            content: [
              { type: "text", text: "Checking the files." },
              { type: "tool_use", id: call.id, name: call.name, input: call.args },
            ],
          },
        ],
      },
      false,
      credentials
    );
    for (const result of [openai, claude]) {
      assert.deepEqual(result.contents[1].parts, [{ text: "Checking the files." }, signed]);
      assert.equal(result.contents[1].parts[0].thoughtSignature, undefined);
    }
    assert.equal(
      store.getAgyEnterpriseTextSignature(namespace, "Checking the files.", history),
      null
    );
    assert.throws(
      () =>
        openaiToGeminiRequest(
          model,
          { messages: [body.messages[0], { role: "assistant", content: "Checking the files." }] },
          false,
          credentials
        ),
      /replay/
    );
    body.messages[1].content = "Changed text";
    assert.throws(() => openaiToGeminiRequest(model, body, false, credentials), /replay/);
  }
});

test("Enterprise buffered mixed text records retain the same scoped native turn", () => {
  store.clearGeminiThoughtSignatures();
  const reply = event([
    { text: "Checking the files." },
    signed,
    { text: "", thoughtSignature: "dGFpbA==" },
  ]);
  parseSSEToGeminiResponse(`data: ${JSON.stringify(reply)}\n\n`, model, {
    provider: "agy-enterprise",
    connectionId: "integrity",
    experience: model,
    history,
  });
  const body = toolHistory();
  body.messages[1].content = "Checking the files.";
  assert.doesNotThrow(() => openaiToGeminiRequest(model, body, false, credentials));
  body.messages[1].tool_calls[0].function.arguments = '{"path":"changed"}';
  assert.throws(() => openaiToGeminiRequest(model, body, false, credentials), /replay/);
});
