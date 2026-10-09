import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../fixtures/agy-enterprise/captured-protocol/", import.meta.url);

test("evidence headers contain placeholders and no live authorization or project", () => {
  for (const i of [23, 25, 33, 35, 38, 43]) {
    const metadata = JSON.parse(fs.readFileSync(new URL(`flow-${i}.http.json`, root), "utf8"));
    assert.match(metadata.request.url, /projects\/SANITIZED_PROJECT\/locations\/us/);
    assert.equal(
      metadata.request.headers.find(
        (h: { name: string }) => h.name.toLowerCase() === "authorization"
      ).value,
      "Bearer SANITIZED_TOKEN"
    );
  }
});
