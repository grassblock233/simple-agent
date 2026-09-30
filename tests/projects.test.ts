import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

test("project creation saves names and reuses eligible drafts", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-create-"));
  const previous = process.env.AGENT_DATA_DIR;
  process.env.AGENT_DATA_DIR = path.join(root, "data");
  const store = await import("../src/lib/store");
  const { POST } = await import("../src/app/api/[...path]/route");
  const workspace = path.join(root, "项目 folder");
  await mkdir(workspace);
  const create = (name: unknown, directory = workspace) => POST(new NextRequest("http://localhost/api/projects", {
    method: "POST", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ action: "create", name, workspace: directory }),
  }), { params: Promise.resolve({ path: ["projects"] }) });
  try {
    const first = await (await create("  My project  ")).json();
    assert.equal(first.project.name, "My project");
    assert.equal(first.project.workspace, workspace);
    assert.equal(first.project.hidden, false);
    assert.equal(first.session.workspace, workspace);
    await t.test("concurrent retries reuse a draft and update the name", async () => {
      const responses = await Promise.all([create("Renamed"), create("Renamed")]);
      for (const response of responses) {
        assert.equal(response.status, 200);
        assert.equal((await response.json()).session.id, first.session.id);
      }
      assert.equal((await store.getProject(workspace)).name, "Renamed");
      assert.equal((await store.listSessions()).length, 1);
    });
    await t.test("readding a removed project preserves archived history", async () => {
      await store.updateSessionsForWorkspace(workspace, { archived: true });
      await store.updateProject(workspace, { hidden: true });
      const restored = await (await create("Restored")).json();
      assert.equal(restored.project.hidden, false);
      assert.notEqual(restored.session.id, first.session.id);
      assert.equal((await store.getSession(first.session.id))?.archived, true);
      const session = restored.session;
      session.messages.push({ role: "user", content: "history" });
      await store.saveSession(session);
      const next = await (await create("Restored")).json();
      assert.notEqual(next.session.id, session.id);
    });
    await t.test("invalid directories and blank names create nothing", async () => {
      const before = (await store.listSessions()).length;
      await writeFile(path.join(root, "file.txt"), "file");
      for (const [name, directory] of [["", workspace], [123, workspace], ["Name", "relative"], ["Name", path.join(root, "missing")], ["Name", path.join(root, "file.txt")]] as const) {
        assert.equal((await create(name, directory)).status, 400);
      }
      assert.equal((await store.listSessions()).length, before);
    });
  } finally {
    if (previous === undefined) delete process.env.AGENT_DATA_DIR; else process.env.AGENT_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
