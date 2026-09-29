import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createSession, deleteSession, getSession, imagePath, saveImage } from "../src/lib/store";
import { detectImage, readText, validateImage, workspacePath, writeText } from "../src/lib/files";
import { dangerousCommand, executeShell } from "../src/lib/shell";
import { resolveApproval, runAgent, stopRun } from "../src/lib/agent";
import { runTool } from "../src/lib/tools";
import { setRuntimeKey, streamModel } from "../src/lib/model";
import type { LiveEvent } from "../src/lib/types";

test("file tools reject traversal and symlink escapes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-files-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "simple-agent-outside-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await symlink(outside, path.join(root, "escape"));
    await assert.rejects(workspacePath(root, "../secret.txt"), /工作区外/);
    await assert.rejects(readText(root, "escape/secret.txt"), /符号链接/);
    await assert.rejects(workspacePath(root, ".env.local", true), /凭据/);
    await writeText(root, "src/hello.txt", "hello");
    assert.equal(await readText(root, "src/hello.txt"), "hello");
    await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
    await assert.rejects(readText(root, "binary"), /二进制/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("image signatures and shell limits", async () => {
  assert.equal(detectImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), "image/png");
  assert.equal(detectImage(Buffer.from("not an image")), null);
  await assert.rejects(validateImage(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), /无法解码/);
  assert.equal(await validateImage(await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer()), "image/png");
  assert.match(dangerousCommand("sudo whoami") || "", /提权/);
  const controller = new AbortController();
  const previous = process.env.DEEPSEEK_API_KEY;
  const previousTimeout = process.env.SHELL_TIMEOUT_MS;
  process.env.DEEPSEEK_API_KEY = "private-test-key";
  process.env.SHELL_TIMEOUT_MS = "1000";
  try {
    const result = await executeShell("node -e 'console.log(process.env.DEEPSEEK_API_KEY || \"none\")'", os.tmpdir(), controller.signal);
    assert.equal(result.exitCode, 0);
    assert.equal(result.output.trim(), "none");
    const timed = await executeShell("node -e 'console.log(\"started\"); setTimeout(() => {}, 5000)'", os.tmpdir(), controller.signal);
    assert.equal(timed.timedOut, true);
    assert.match(timed.output, /started/);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
    if (previousTimeout === undefined) delete process.env.SHELL_TIMEOUT_MS;
    else process.env.SHELL_TIMEOUT_MS = previousTimeout;
  }
});

test("tool arguments fail cleanly and existing files require a read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-tool-"));
  const session = await createSession(root);
  const context = { session, signal: new AbortController().signal, readPaths: new Set<string>(), requestApproval: async () => false };
  try {
    await writeFile(path.join(root, "existing.txt"), "old");
    await assert.rejects(runTool({ id: "bad", type: "function", function: { name: "read_file", arguments: "{" } }, context), /有效 JSON/);
    const write = { id: "write", type: "function" as const, function: { name: "write_file", arguments: '{"path":"existing.txt","content":"new"}' } };
    await assert.rejects(runTool(write, context), /先读取/);
    await runTool({ id: "read", type: "function", function: { name: "read_file", arguments: '{"path":"existing.txt"}' } }, context);
    await runTool(write, context);
    assert.equal(await readFile(path.join(root, "existing.txt"), "utf8"), "new");
  } finally { await deleteSession(session.id); await rm(root, { recursive: true, force: true }); }
});

test("uploaded image becomes a vision block in the model request", async () => {
  const id = randomUUID();
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } }).png().toBuffer();
  await saveImage(id, bytes);
  const originalFetch = globalThis.fetch;
  let request: { messages?: { content?: unknown }[] } = {};
  globalThis.fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return sse([{ content: "一张图片" }]);
  };
  setRuntimeKey("test-key");
  try {
    const response = await streamModel([{ role: "user", content: "描述图片", images: [{ id, mime: "image/png", name: "sample.png" }] }], true, new AbortController().signal, () => {});
    assert.equal(response.content, "一张图片");
    const user = request.messages?.[1]?.content as { image_url?: { url: string } }[];
    assert.match(user[1].image_url?.url || "", /^data:image\/png;base64,/);
  } finally {
    globalThis.fetch = originalFetch;
    setRuntimeKey("");
    await rm(imagePath(id), { force: true });
  }
});

function sse(deltas: object[]): Response {
  const encoder = new TextEncoder();
  const content = `${deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`).join("")}data: [DONE]\n\n`;
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    for (let index = 0; index < content.length; index += 17) controller.enqueue(encoder.encode(content.slice(index, index + 17)));
    controller.close();
  } });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("agent handles multiple streamed tool calls, approval and reasoning history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-run-"));
  const session = await createSession(root);
  const requests: object[] = [];
  const responses = [
    sse([
      { reasoning_content: "检查目录并写入文件。" },
      { tool_calls: [{ index: 0, id: "call-1", function: { name: "list_directory", arguments: '{"path":"."}' } }] },
      { tool_calls: [{ index: 1, id: "call-2", function: { name: "write_file", arguments: '{"path":"hello.js","content":"console.log(' } }] },
      { tool_calls: [{ index: 1, function: { arguments: '\\"ok\\");"}' } }] },
    ]),
    sse([{ reasoning_content: "运行验证。" }, { tool_calls: [{ index: 0, id: "call-3", function: { name: "run_shell", arguments: '{"command":"node hello.js"}' } }] }]),
    sse([{ content: "已写入 hello.js，并通过 node hello.js 验证。" }]),
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const response = responses.shift();
    if (!response) throw new Error("unexpected model request");
    return response;
  };
  setRuntimeKey("test-key");
  const events: LiveEvent[] = [];
  try {
    await runAgent(session.id, "写一个 hello.js 并执行", [], (event) => {
      events.push(event);
      if (event.type === "event" && event.event.approvalId && event.event.status === "pending") {
        assert.equal(resolveApproval(event.event.approvalId, true), true);
      }
    });
    const saved = await getSession(session.id);
    assert.ok(saved);
    assert.equal(saved.messages.filter((message) => message.role === "tool").length, 3);
    assert.equal(saved.messages.filter((message) => message.role === "assistant").length, 3);
    assert.equal((saved.messages[1] as { reasoning_content: string }).reasoning_content, "检查目录并写入文件。");
    assert.match(await readFile(path.join(root, "hello.js"), "utf8"), /console\.log/);
    assert.ok(saved.events.some((event) => event.type === "tool" && event.name === "run_shell" && event.status === "success"));
    assert.ok((requests[1] as { messages: { reasoning_content?: string }[] }).messages.some((message) => message.reasoning_content === "检查目录并写入文件。"));
    assert.ok(events.some((event) => event.type === "delta" && event.field === "answer"));
  } finally {
    globalThis.fetch = originalFetch;
    setRuntimeKey("");
    await deleteSession(session.id);
    await rm(root, { recursive: true, force: true });
  }
});

test("stop during approval preserves a paired tool result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-stop-"));
  const session = await createSession(root);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sse([{ tool_calls: [{ index: 0, id: "call-stop", function: { name: "run_shell", arguments: '{"command":"node -v"}' } }] }]);
  setRuntimeKey("test-key");
  try {
    await runAgent(session.id, "检查 Node", [], (event) => {
      if (event.type === "event" && event.event.approvalId && event.event.status === "pending") assert.equal(stopRun(session.id), true);
    });
    const saved = await getSession(session.id);
    assert.ok(saved);
    assert.deepEqual(saved.messages.map((message) => message.role), ["user", "assistant", "tool"]);
    assert.match((saved.messages[2] as { content: string }).content, /用户拒绝/);
  } finally {
    globalThis.fetch = originalFetch;
    setRuntimeKey("");
    await deleteSession(session.id);
    await rm(root, { recursive: true, force: true });
  }
});
