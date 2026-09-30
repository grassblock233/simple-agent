import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maybeCompact } from "../src/lib/context";
import { createSession, deleteSession, saveSession } from "../src/lib/store";
import { estimateTokens, setRuntimeKey } from "../src/lib/model";
import type { ChatMessage } from "../src/lib/types";

test("compression cuts only between complete user turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-context-"));
  const session = await createSession(root);
  const originalFetch = globalThis.fetch;
  const originalBudget = process.env.CONTEXT_TOKEN_BUDGET;
  process.env.CONTEXT_TOKEN_BUDGET = "4000";
  setRuntimeKey("test-key");
  const requests: object[] = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "目标：修复代码；已运行测试，仍需处理边界。" } }] }), { status: 200 });
  };
  try {
    session.settings.threshold = 0.1;
    const messages: ChatMessage[] = [];
    for (let index = 0; index < 6; index++) {
      messages.push({ role: "user", content: `第 ${index} 轮 ${"详细需求".repeat(80)}` });
      messages.push({ role: "assistant", content: null, reasoning_content: "分析", tool_calls: [{ id: `call-${index}`, type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } }] });
      messages.push({ role: "tool", tool_call_id: `call-${index}`, content: "读取结果" });
      messages.push({ role: "assistant", content: "完成", reasoning_content: "总结" });
    }
    session.messages = messages;
    await saveSession(session);
    await maybeCompact(session, new AbortController().signal, () => {});
    assert.equal(session.contextStart, 12);
    assert.equal(session.messages[session.contextStart].role, "user");
    assert.match(session.summary, /目标：修复代码/);
    assert.equal(requests.length, 1);
    assert.equal(session.events.at(-1)?.type, "compression");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBudget === undefined) delete process.env.CONTEXT_TOKEN_BUDGET;
    else process.env.CONTEXT_TOKEN_BUDGET = originalBudget;
    setRuntimeKey("");
    await deleteSession(session.id);
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled compression keeps the initial goal in a visible fallback summary", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-fallback-"));
  const session = await createSession(root);
  const originalBudget = process.env.CONTEXT_TOKEN_BUDGET;
  process.env.CONTEXT_TOKEN_BUDGET = "4000";
  try {
    session.settings.compression = false;
    session.settings.threshold = 0.1;
    for (let index = 0; index < 6; index++) {
      session.messages.push({ role: "user", content: index === 0 ? `最初目标修复登录错误 ${"详情".repeat(100)}` : `第 ${index} 轮 ${"详情".repeat(100)}` });
      session.messages.push({ role: "assistant", content: "已处理" });
    }
    await maybeCompact(session, new AbortController().signal, () => {});
    assert.equal(session.contextStart, 6);
    assert.match(session.summary, /最初目标修复登录错误/);
    assert.equal(session.events.at(-1)?.status, "failed");
  } finally {
    if (originalBudget === undefined) delete process.env.CONTEXT_TOKEN_BUDGET;
    else process.env.CONTEXT_TOKEN_BUDGET = originalBudget;
    await deleteSession(session.id);
    await rm(root, { recursive: true, force: true });
  }
});

test("compression can release oversized history with only two user turns", async () => {
  const session = await createSession(os.tmpdir());
  const originalBudget = process.env.CONTEXT_TOKEN_BUDGET;
  process.env.CONTEXT_TOKEN_BUDGET = "4000";
  try {
    session.settings.compression = false;
    session.messages = [
      { role: "user", content: "修复错误" },
      { role: "assistant", content: "历史".repeat(5000), reasoning_content: "原始思考" },
      { role: "user", content: "继续" },
    ];
    await maybeCompact(session, new AbortController().signal, () => {});
    assert.equal(session.contextStart, 2);
    assert.ok(estimateTokens(session.messages.slice(session.contextStart), session.summary) < 4000);
    assert.equal(session.messages[1].role === "assistant" && session.messages[1].reasoning_content, "原始思考");
  } finally {
    if (originalBudget === undefined) delete process.env.CONTEXT_TOKEN_BUDGET;
    else process.env.CONTEXT_TOKEN_BUDGET = originalBudget;
    await deleteSession(session.id);
  }
});

test("cancelled summarization leaves context and history unchanged", async () => {
  const session = await createSession(os.tmpdir());
  const originalBudget = process.env.CONTEXT_TOKEN_BUDGET;
  const originalFetch = globalThis.fetch;
  process.env.CONTEXT_TOKEN_BUDGET = "4000";
  const controller = new AbortController();
  setRuntimeKey("test-key");
  globalThis.fetch = async () => { controller.abort(); throw new Error("aborted"); };
  try {
    session.messages = [{ role: "user", content: "目标".repeat(5000) }, { role: "assistant", content: "完成" }, { role: "user", content: "继续" }];
    await assert.rejects(maybeCompact(session, controller.signal, () => {}), { name: "AbortError" });
    assert.equal(session.contextStart, 0);
    assert.equal(session.summary, "");
    assert.equal(session.events.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBudget === undefined) delete process.env.CONTEXT_TOKEN_BUDGET;
    else process.env.CONTEXT_TOKEN_BUDGET = originalBudget;
    setRuntimeKey("");
    await deleteSession(session.id);
  }
});

test("compression retains fewer turns when three turns cannot fit", async () => {
  const session = await createSession(os.tmpdir());
  const originalBudget = process.env.CONTEXT_TOKEN_BUDGET;
  process.env.CONTEXT_TOKEN_BUDGET = "4000";
  try {
    session.settings.compression = false;
    for (let index = 0; index < 4; index++) {
      session.messages.push({ role: "user", content: `目标 ${index}` }, { role: "assistant", content: "长历史".repeat(800) });
    }
    session.messages.push({ role: "user", content: "继续处理最后的问题" });
    await maybeCompact(session, new AbortController().signal, () => {});
    assert.equal(session.contextStart, 6);
    assert.ok(session.summary.length <= 800);
    assert.ok(estimateTokens(session.messages.slice(session.contextStart), session.summary) < 4000);
  } finally {
    if (originalBudget === undefined) delete process.env.CONTEXT_TOKEN_BUDGET;
    else process.env.CONTEXT_TOKEN_BUDGET = originalBudget;
    await deleteSession(session.id);
  }
});
