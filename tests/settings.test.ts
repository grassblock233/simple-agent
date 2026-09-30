import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

test("settings defaults and archive restoration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-settings-"));
  const previousDataDir = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = path.join(root, "data");
  const store = await import("../src/lib/store");
  const { GET, PATCH } = await import("../src/app/api/[...path]/route");
  const context = (parts: string[]) => ({ params: Promise.resolve({ path: parts }) });
  const patch = (parts: string[], body: unknown) => PATCH(new NextRequest(`http://localhost/api/${parts.join("/")}`, { method: "PATCH", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) }), context(parts));
  try {
    const original = await store.createSession(root);
    await t.test("defaults persist and affect new sessions only", async () => {
      const response = await patch(["settings"], { sessionDefaults: { reasoningEffort: "low", maxAttempts: 5, compression: false, threshold: 0.5 } });
      assert.equal(response.status, 200);
      const saved = JSON.parse(await readFile(path.join(root, "data/settings.json"), "utf8"));
      assert.deepEqual(saved, await store.getAppSettings());
      const next = await store.createSession(root);
      assert.deepEqual(next.settings, saved.sessionDefaults);
      assert.equal((await store.getSession(original.id))?.settings.reasoningEffort, "high");
      assert.deepEqual(await (await GET(new NextRequest("http://localhost/api/settings"), context(["settings"]))).json(), saved);
      const legacy = await store.createSession(root);
      legacy.settings = {} as typeof legacy.settings;
      await store.saveSession(legacy);
      assert.deepEqual((await store.getSession(legacy.id))?.settings, original.settings);
    });
    await t.test("invalid defaults are rejected without replacing saved settings", async () => {
      const before = await store.getAppSettings();
      for (const invalid of [{ maxAttempts: 0 }, { maxAttempts: 2.5 }, { threshold: 1 }, { threshold: "0.5" }, { reasoningEffort: "medium" }, { compression: "yes" }, { apiKey: "not-a-setting" }]) {
        const response = await patch(["settings"], { sessionDefaults: invalid });
        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /无效/);
      }
      assert.deepEqual(await store.getAppSettings(), before);
    });
    await t.test("restoring one chat unhides its project but keeps other chats archived", async () => {
      const second = await store.createSession(root);
      original.archived = true; second.archived = true;
      await store.saveSession(original); await store.saveSession(second);
      await store.updateProject(root, { hidden: true });
      assert.equal((await patch(["sessions", original.id], { archived: false })).status, 200);
      assert.equal((await store.getProject(root)).hidden, false);
      assert.equal((await store.getSession(original.id))?.archived, false);
      assert.equal((await store.getSession(second.id))?.archived, true);
      assert.equal((await patch(["sessions", second.id], { archived: false })).status, 200);
      assert.equal((await store.getSession(second.id))?.archived, false);
    });
    await t.test("running sessions cannot be restored or edited", async () => {
      const { runAgent, stopRun } = await import("../src/lib/agent");
      const { setRuntimeKey } = await import("../src/lib/model");
      const originalFetch = globalThis.fetch;
      let entered!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      globalThis.fetch = async (_url, init) => { entered(); return new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }); };
      setRuntimeKey("test-key");
      const running = runAgent(original.id, "测试", [], () => {});
      try {
        await reached;
        assert.equal((await patch(["sessions", original.id], { archived: false })).status, 409);
      } finally { stopRun(original.id); await running; globalThis.fetch = originalFetch; setRuntimeKey(""); }
    });
  } finally {
    if (previousDataDir === undefined) delete process.env.AGENT_DATA_DIR;
    else process.env.AGENT_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
