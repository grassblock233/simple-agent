import test from "node:test";
import assert from "node:assert/strict";
import { checkOrigin } from "../src/lib/origin";

test("accepts the browser origin matching Host even when an internal URL differs", () => {
  assert.doesNotThrow(() => checkOrigin(new Headers({ origin: "http://127.0.0.1:3000", host: "127.0.0.1:3000" }), "http:"));
  assert.doesNotThrow(() => checkOrigin(new Headers({ origin: "http://localhost:3000", host: "localhost:3000" }), "http:"));
  assert.doesNotThrow(() => checkOrigin(new Headers({ host: "127.0.0.1:3000" }), "http:"));
});

test("rejects a different host or malformed origin", () => {
  assert.throws(() => checkOrigin(new Headers({ origin: "http://evil.example", host: "127.0.0.1:3000" }), "http:"), /跨来源/);
  assert.throws(() => checkOrigin(new Headers({ origin: "http://127.0.0.1:3001", host: "127.0.0.1:3000" }), "http:"), /跨来源/);
  assert.throws(() => checkOrigin(new Headers({ origin: "https://127.0.0.1:3000", host: "127.0.0.1:3000" }), "http:"), /跨来源/);
  assert.throws(() => checkOrigin(new Headers({ origin: "invalid", host: "127.0.0.1:3000" }), "http:"), /跨来源/);
});
