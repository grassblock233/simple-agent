import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/[...path]/route";
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

test("removing a project works after its directory disappears", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-remove-project-"));
  const workspace = path.join(root, "missing-project");
  await mkdir(workspace);
  const first = await createSession(workspace);
  const second = await createSession(workspace);
  const other = await createSession(root);
  const context = { params: Promise.resolve({ path: ["projects"] }) };
  const act = (action: string, directory = workspace) => POST(new NextRequest("http://localhost/api/projects", {
    method: "POST", headers: { origin: "http://localhost", host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ action, workspace: directory }),
  }), context);
  try {
    await updateProject(workspace, { name: "Missing project", pinned: true });
    await rm(workspace, { recursive: true });
    assert.equal((await act("remove", "relative/project")).status, 400);
    assert.equal((await getProject(workspace)).hidden, false);
    const response = await act("remove");
    assert.equal(response.status, 200);
    const removed = await response.json();
    assert.equal(removed.workspace, workspace);
    assert.equal(removed.hidden, true);
    assert.equal(removed.name, "Missing project");
    assert.equal((await getProject(workspace)).hidden, true);
    assert.equal((await getSession(first.id))?.archived, true);
    assert.equal((await getSession(second.id))?.archived, true);
    assert.equal((await getSession(other.id))?.archived, false);
    assert.equal((await act("remove")).status, 200);
    assert.equal((await act("open")).status, 400);
    const presentFile = path.join(root, "keep.txt");
    await writeFile(presentFile, "keep");
    assert.equal((await act("remove", root)).status, 200);
    assert.equal(await readFile(presentFile, "utf8"), "keep");
  } finally {
    await deleteSession(first.id); await deleteSession(second.id); await deleteSession(other.id);
    await rm(root, { recursive: true, force: true });
  }
});
