import test from "node:test";
import assert from "node:assert/strict";
import { agyEnterpriseFetchJson } from "../../open-sse/services/agyEnterprise.ts";

const endpoint = "https://businessaicode.googleapis.com/v1beta:fetchLicenses";

test("Enterprise 403 preserves Google diagnostics in errors and logs without credentials", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          code: 403,
          status: "PERMISSION_DENIED",
          message: "Request had insufficient authentication scopes. Echo: opaque-test-access",
          access_token: "opaque-test-access",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.ErrorInfo",
              reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
              domain: "googleapis.com",
              metadata: { service: "businessaicode.googleapis.com", method: "FetchLicenses" },
            },
          ],
          debug: "Failure\n    at run (C:\\private\\server.ts:12:3)",
        },
      },
      { status: 403, statusText: "Forbidden", headers: { "x-request-id": "request-one" } }
    )
  );
  await assert.rejects(agyEnterpriseFetchJson(endpoint, "opaque-test-access"), (error: unknown) => {
    assert.ok(error instanceof Error);
    const failure = error as Error & {
      status: number;
      diagnostics: { elapsedMs: number; upstream: Record<string, unknown> };
    };
    assert.equal(failure.status, 403);
    assert.ok(failure.diagnostics.elapsedMs >= 0);
    assert.match(failure.message, /PERMISSION_DENIED/);
    assert.match(failure.message, /ACCESS_TOKEN_SCOPE_INSUFFICIENT/);
    assert.match(failure.message, /FetchLicenses/);
    assert.match(failure.message, /request-one/);
    assert.match(failure.message, /insufficient authentication scopes/);
    assert.equal(failure.diagnostics.upstream.access_token, undefined);
    return true;
  });
  assert.equal(logs.length, 1);
  const logged = JSON.stringify(logs);
  assert.ok(logged.includes(endpoint));
  assert.ok(logged.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT"));
  assert.ok(!logged.includes("opaque-test-access"));
  assert.ok(!logged.includes("private"));
  assert.ok(!logged.includes("at run"));
});

test("Enterprise errors retain non-JSON and empty bodies and tolerate unreadable bodies", async (t) => {
  t.mock.method(console, "error", () => {});
  for (const body of ["Proxy denied access: Bearer opaque-test-access", ""]) {
    t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 502 }));
    await assert.rejects(
      agyEnterpriseFetchJson(endpoint, "opaque-test-access"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, body ? /Proxy denied access/ : /empty response body/);
        assert.ok(!error.message.includes("opaque-test-access"));
        return true;
      }
    );
  }
  const response = new Response("failure", { status: 503 });
  t.mock.method(response, "text", async () => {
    throw new Error("body read failed");
  });
  t.mock.method(globalThis, "fetch", async () => response);
  await assert.rejects(agyEnterpriseFetchJson(endpoint, "opaque-test-access"), /Unable to read/);
});
