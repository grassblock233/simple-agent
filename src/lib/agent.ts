import { randomUUID } from "node:crypto";
import { maybeCompact } from "./context";
import { contextBudget, getSession, makeEvent, saveSession, withSessionLock } from "./store";
import { estimateTokens, hasApiKey, streamModel } from "./model";
import { runTool } from "./tools";
import type { Event, ImageRef, LiveEvent, Session, ToolCall } from "./types";

type ActiveRun = { controller: AbortController; approval?: { id: string; resolve: (approved: boolean) => void }; sessionId: string };
const active = new Map<string, ActiveRun>();

export function isRunning(sessionId: string): boolean { return active.has(sessionId); }

export function stopRun(sessionId: string): boolean {
  const run = active.get(sessionId);
  if (!run) return false;
  run.controller.abort();
  run.approval?.resolve(false);
  run.approval = undefined;
  return true;
}

export function resolveApproval(id: string, approved: boolean): boolean {
  for (const run of active.values()) {
    if (run.approval?.id === id) {
      run.approval.resolve(approved);
      run.approval = undefined;
      return true;
    }
  }
  return false;
}

async function append(session: Session, event: Event, emit: (value: LiveEvent) => void): Promise<void> {
  session.events.push(event);
  await saveSession(session);
  emit({ type: "event", event });
}

async function approval(run: ActiveRun, session: Session, command: string, emit: (value: LiveEvent) => void): Promise<boolean> {
  const id = randomUUID();
  const event = makeEvent("notice", { text: "Shell 命令等待批准。批准后以当前用户权限执行，可能访问工作区外资源。", name: "run_shell", args: command, status: "pending", approvalId: id });
  const decision = new Promise<boolean>((resolve) => {
    const finish = (approved: boolean) => {
      clearTimeout(timer);
      event.status = approved ? "success" : "denied";
      void saveSession(session).then(() => emit({ type: "event", event }));
      resolve(approved);
    };
    const timer = setTimeout(() => { if (run.approval?.id === id) run.approval = undefined; finish(false); }, 300000);
    run.approval = { id, resolve: finish };
    if (run.controller.signal.aborted) run.approval.resolve(false);
  });
  await append(session, event, emit);
  return decision;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeCall(call: ToolCall, run: ActiveRun, session: Session, reads: Set<string>, emit: (value: LiveEvent) => void): Promise<{ content: string; failed: boolean }> {
  const started = Date.now();
  const event = makeEvent("tool", { name: call.function.name, args: call.function.arguments, status: "pending" });
  await append(session, event, emit);
  emit({ type: "status", status: `正在执行 ${call.function.name}` });
  let content: string;
  let failed = false;
  try {
    if (run.controller.signal.aborted) throw new Error("执行已停止");
    content = await runTool(call, { session, signal: run.controller.signal, readPaths: reads, requestApproval: (command) => approval(run, session, command, emit) });
  } catch (error) {
    failed = true;
    content = failureText(error);
  }
  event.result = content.slice(0, 24000);
  event.status = failed ? /拒绝|拦截/.test(content) ? "denied" : "failed" : "success";
  event.durationMs = Date.now() - started;
  await saveSession(session);
  emit({ type: "event", event });
  return { content: `${failed ? "错误: " : ""}${content}`, failed };
}

export async function runAgent(sessionId: string, text: string, images: ImageRef[], emit: (value: LiveEvent) => void): Promise<void> {
  if (active.has(sessionId)) throw new Error("此会话已有运行中的任务");
  if (!await hasApiKey()) throw new Error("未配置 DeepSeek API Key，请在设置中填写");
  if (active.has(sessionId)) throw new Error("此会话已有运行中的任务");
  const run: ActiveRun = { controller: new AbortController(), sessionId };
  active.set(sessionId, run);
  try {
    await withSessionLock(sessionId, async () => {
      const session = await getSession(sessionId);
      if (!session) throw new Error("会话不存在");
      if (!text.trim() && images.length === 0) throw new Error("请输入需求或添加图片");
      session.messages.push({ role: "user", content: text.trim(), images });
      if (session.title === "新会话") session.title = text.trim().slice(0, 28) || "图片任务";
      await append(session, makeEvent("user", { text: text.trim(), images }), emit);
      const reads = new Set<string>();
      let failedChecks = 0;
      let dirty = false;
      let verificationPrompted = false;
      while (!run.controller.signal.aborted) {
        await maybeCompact(session, run.controller.signal, (event) => emit({ type: "event", event }));
        const occupancy = estimateTokens(session.messages.slice(session.contextStart), session.summary) / contextBudget();
        if (occupancy >= 1) throw new Error("当前轮次已超过上下文预算，无法在不拆散工具调用的情况下继续。请新建会话并附上任务进展，或提高 CONTEXT_TOKEN_BUDGET（最高 1M）。");
        emit({ type: "status", status: "模型生成中", occupancy });
        const assistant = await streamModel(session.messages.slice(session.contextStart), session.settings.reasoningEffort, run.controller.signal, (delta) => {
          if (delta.content) emit({ type: "delta", field: "answer", text: delta.content });
          if (delta.reasoning) emit({ type: "delta", field: "reasoning", text: delta.reasoning });
        }, session.summary, dirty ? "代码已写入但仍未验证。请尝试运行合适的测试或明确说明无法运行。" : "");
        if (run.controller.signal.aborted) break;
        if (assistant.reasoning_content) await append(session, makeEvent("reasoning", { text: assistant.reasoning_content }), emit);
        if (assistant.content) await append(session, makeEvent("answer", { text: assistant.content }), emit);
        if (!assistant.tool_calls?.length) {
          session.messages.push(assistant);
          await saveSession(session);
          if (dirty && !verificationPrompted) { verificationPrompted = true; continue; }
          if (dirty) await append(session, makeEvent("notice", { text: "文件已修改，但没有成功的验证命令；请检查最终回答中的限制。", status: "failed" }), emit);
          break;
        }
        const results: { role: "tool"; tool_call_id: string; content: string }[] = [];
        for (const call of assistant.tool_calls) {
          const result = await executeCall(call, run, session, reads, emit);
          results.push({ role: "tool", tool_call_id: call.id, content: result.content });
          if (call.function.name === "write_file" && !result.failed) dirty = true;
          if (call.function.name === "run_shell") {
            if (result.failed || !result.content.includes('"exitCode":0')) failedChecks++;
            else dirty = false;
          }
        }
        session.messages.push(assistant, ...results);
        await saveSession(session);
        if (failedChecks >= session.settings.maxAttempts) {
          const attempts = session.events.filter((event) => event.type === "tool" && event.name === "run_shell" && event.status !== "success");
          const commands = attempts.map((event) => { try { return (JSON.parse(event.args || "{}") as { command?: string }).command || event.args; } catch { return event.args; } });
          const last = attempts.at(-1);
          await append(session, makeEvent("notice", { text: `验证失败达到 ${failedChecks} 次上限。已尝试：${commands.join("；") || "无"}。最后错误：${last?.result?.slice(0, 800) || "未知"}。请检查报错、依赖和工作目录后继续。`, status: "failed" }), emit);
          break;
        }
      }
      if (run.controller.signal.aborted) await append(session, makeEvent("notice", { text: "已停止生成。已完成的工具结果保留，未完成的模型输出未加入后续上下文。" }), emit);
      emit({ type: "status", status: "就绪", occupancy: estimateTokens(session.messages.slice(session.contextStart), session.summary) / contextBudget() });
    });
  } catch (error) {
    const session = await getSession(sessionId);
    if (session) await append(session, makeEvent(run.controller.signal.aborted ? "notice" : "error", { text: run.controller.signal.aborted ? "已停止生成。可以继续提问。" : failureText(error), status: run.controller.signal.aborted ? undefined : "failed" }), emit);
    else throw error;
  } finally {
    run.approval?.resolve(false);
    active.delete(sessionId);
    emit({ type: "done" });
  }
}
