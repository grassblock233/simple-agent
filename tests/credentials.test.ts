import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

test("API credentials persist privately and survive a fresh process", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "simple-agent-credentials-"));
  const previousDataDir = process.env.AGENT_DATA_DIR;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.AGENT_DATA_DIR = root;
  delete process.env.DEEPSEEK_API_KEY;
  const store = await import("../src/lib/store");
  const model = await import("../src/lib/model");
  const { readText, searchText } = await import("../src/lib/files");
  const { GET, POST } = await import("../src/app/api/[...path]/route");
  const file = path.join(root, "credentials.key");
  const context = (name: string) => ({ params: Promise.resolve({ path: [name] }) });
  const save = (apiKey: unknown) => POST(new NextRequest("http://localhost/api/config", {
    method: "POST", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ apiKey }),
  }), context("config"));
  try {
    await t.test("missing file falls back to environment; saving trims and persists", async () => {
      assert.equal(await model.hasApiKey(), false);
      process.env.DEEPSEEK_API_KEY = "environment-key";
      assert.equal(await model.hasApiKey(), true);
      const response = await save("  saved-secret  ");
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { hasApiKey: true });
      assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { apiKey: "saved-secret" });
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    });
    await t.test("fresh process reads saved key for status and model authorization", async () => {
      const script = `
        const assert = require('node:assert/strict');
        const { hasApiKey, streamModel } = require('./src/lib/model.ts');
        (async () => {
          assert.equal(await hasApiKey(), true);
          globalThis.fetch = async (_url, init) => {
            assert.equal(init.headers.Authorization, 'Bearer saved-secret');
            return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\\n\\ndata: [DONE]\\n\\n');
          };
          const reply = await streamModel([], 'off', new AbortController().signal, () => {});
          assert.equal(reply.content, 'ok');
        })().catch(() => { process.exitCode = 1; });
      `;
      await promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", script], { cwd: process.cwd(), env: { ...process.env, DEEPSEEK_API_KEY: "environment-key" } });
    });
    await t.test("configuration and file tools never expose credentials", async () => {
      const config = await GET(new NextRequest("http://localhost/api/config"), context("config"));
      assert.deepEqual(await config.json(), { hasApiKey: true, model: "deepseek-flash" });
      const settings = await GET(new NextRequest("http://localhost/api/settings"), context("settings"));
      assert.equal((await settings.text()).includes("saved-secret"), false);
      await assert.rejects(readText(root, "credentials.key"), /凭据/);
      await assert.rejects(searchText(root, "saved-secret"), /未找到/);
    });
    await t.test("replacement, concurrent writes and clearing preserve permissions", async () => {
      assert.equal((await save("replacement-key")).status, 200);
      assert.equal(await store.getStoredApiKey(), "replacement-key");
      await Promise.all([store.saveStoredApiKey("first-key"), store.saveStoredApiKey("last-key")]);
      assert.equal(await store.getStoredApiKey(), "last-key");
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      assert.equal((await save("  ")).status, 200);
      assert.equal(await store.getStoredApiKey(), "");
      assert.equal(await model.hasApiKey(), true);
      delete process.env.DEEPSEEK_API_KEY;
      assert.equal(await model.hasApiKey(), false);
      model.setRuntimeKey("runtime-key");
      assert.equal(await model.hasApiKey(), true);
      model.setRuntimeKey("");
      assert.equal(await model.hasApiKey(), false);
    });
    await t.test("invalid input and failed atomic replacement keep the old key", async () => {
      await store.saveStoredApiKey("retained-secret");
      assert.equal((await save(123)).status, 400);
      const mocked = t.mock.method(fs, "rename", async () => { throw new Error("retained-secret"); });
      try {
        const response = await save("new-secret");
        assert.equal(response.status, 400);
        const error = await response.text();
        assert.match(error, /无法保存 API Key/);
        assert.equal(error.includes("secret"), false);
        assert.equal(await store.getStoredApiKey(), "retained-secret");
        assert.deepEqual(await fs.readdir(root), ["credentials.key"]);
      } finally { mocked.mock.restore(); }
    });
    await t.test("corrupt and unreadable files produce sanitized errors", async () => {
      for (const content of ['{"apiKey":"private-secret",', '{"apiKey":123}']) {
        await fs.writeFile(file, content);
        const response = await GET(new NextRequest("http://localhost/api/config"), context("config"));
        assert.equal(response.status, 400);
        const error = await response.text();
        assert.match(error, /无法读取 API Key/);
        assert.equal(error.includes("private-secret"), false);
      }
      await store.saveStoredApiKey("repaired-key");
      assert.equal(await model.hasApiKey(), true);
      const mocked = t.mock.method(fs, "readFile", async () => { throw new Error("private-secret"); });
      try { await assert.rejects(store.getStoredApiKey(), /^Error: 无法读取 API Key 凭据文件，请检查文件格式和权限$/); }
      finally { mocked.mock.restore(); }
    });
  } finally {
    model.setRuntimeKey("");
    if (previousDataDir === undefined) delete process.env.AGENT_DATA_DIR;
    else process.env.AGENT_DATA_DIR = previousDataDir;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
    await fs.rm(root, { recursive: true, force: true });
  }
});
