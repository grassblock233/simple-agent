import { completeText, estimateTokens } from "./model";
import { contextBudget, makeEvent, saveSession } from "./store";
import type { ChatMessage, Event, Session } from "./types";

function compactInput(messages: ChatMessage[]): string {
  return messages.map((item) => {
    if (item.role === "user") return `用户: ${item.content}${item.images?.length ? ` [${item.images.map((image) => image.name).join(", ")}]` : ""}`;
    if (item.role === "tool") return `工具结果(${item.tool_call_id}): ${item.content.slice(0, 600)}`;
    return `助手: ${(item.content || "").slice(0, 1000)}${item.tool_calls?.map((call) => `\n调用 ${call.function.name} ${call.function.arguments.slice(0, 400)}`).join("") || ""}`;
  }).join("\n");
}

export async function maybeCompact(session: Session, signal: AbortSignal, notify: (event: Event) => void): Promise<void> {
  const budget = contextBudget();
  const active = session.messages.slice(session.contextStart);
  if (estimateTokens(active, session.summary) < budget * session.settings.threshold) return;
  const userStarts = active.flatMap((item, index) => item.role === "user" ? [index] : []);
  if (userStarts.length <= 3) return;
  const cut = session.contextStart + userStarts[userStarts.length - 3];
  const old = session.messages.slice(session.contextStart, cut);
  if (!old.length) return;
  const input = compactInput(old);
  const range = `${session.contextStart + 1}–${cut}`;
  let text: string;
  let degraded = false;
  if (session.settings.compression) {
    try {
      text = await completeText(`请用中文压缩以下代码 Agent 历史。保留用户目标和约束、已修改文件、测试命令及结果、失败原因、未完成事项。只输出摘要，不添加猜测。\n此前摘要:\n${session.summary}\n历史:\n${input.slice(0, 40000)}`, signal);
      if (!text) throw new Error("摘要为空");
    } catch {
      degraded = true;
      const firstGoal = old.find((item) => item.role === "user");
      text = `${session.summary.slice(0, 1500)}\n最初目标：${firstGoal?.role === "user" ? firstGoal.content.slice(0, 1000) : ""}\n近期历史：${input.slice(-4500)}`;
    }
  } else {
    degraded = true;
    const firstGoal = old.find((item) => item.role === "user");
    text = `${session.summary.slice(0, 1500)}\n最初目标：${firstGoal?.role === "user" ? firstGoal.content.slice(0, 1000) : ""}\n近期历史：${input.slice(-4500)}`;
  }
  session.summary = text;
  session.contextStart = cut;
  const event = makeEvent("compression", { text, range, status: degraded ? "failed" : "success" });
  session.events.push(event);
  await saveSession(session);
  notify(event);
}
