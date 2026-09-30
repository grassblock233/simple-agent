import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "../src/app/api/[...path]/route";
import { createSession, deleteSession, getProject, getSession, listProjects, saveSession, updateProject, updateSessionsForWorkspace } from "../src/lib/store";

test("session history stays hidden until the first user message", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "simple-agent-session-"));
  const session = await createSession(workspace);
  const context = { params: Promise.resolve({ path: ["sessions"] }) };
  const request = new NextRequest("http://localhost/api/sessions");
  const listed = async () => (await (await GET(request, context)).json()) as { id: string; hasMessages: boolean }[];

  try {
    assert.equal((await listed()).find((item) => item.id === session.id)?.hasMessages, false);
    session.messages.push({ role: "user", content: "开始任务" });
    await saveSession(session);
    assert.equal((await listed()).find((item) => item.id === session.id)?.hasMessages, true);
  } finally {
    await deleteSession(session.id);
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legacy settings migrate and omit tool round limits", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "simple-agent-legacy-"));
  const session = await createSession(workspace);
  try {
    Object.assign(session.settings, { thinking: false, maxToolRounds: 16 });
    delete (session.settings as { reasoningEffort?: string }).reasoningEffort;
    await saveSession(session);
    const restored = await getSession(session.id);
    assert.equal(restored?.settings.reasoningEffort, "off");
    assert.equal("maxToolRounds" in (restored?.settings || {}), false);
    assert.equal("thinking" in (restored?.settings || {}), false);
  } finally { await deleteSession(session.id); await rm(workspace, { recursive: true, force: true }); }
});

test("project metadata and session archive state persist", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "simple-agent-project-"));
  const session = await createSession(workspace);
  try {
    session.messages.push({ role: "user", content: "任务" });
    await saveSession(session);
    await updateProject(workspace, { name: "演示项目", pinned: true });
    const project = await getProject(workspace);
    assert.deepEqual({ name: project.name, pinned: project.pinned, hidden: project.hidden }, { name: "演示项目", pinned: true, hidden: false });
    assert.equal((await listProjects([workspace])).find((item) => item.workspace === workspace)?.name, "演示项目");
    assert.equal(await updateSessionsForWorkspace(workspace, { archived: true }), 1);
    assert.equal((await getSession(session.id))?.archived, true);
  } finally { await deleteSession(session.id); await rm(workspace, { recursive: true, force: true }); }
});
