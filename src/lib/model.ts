import { getStoredApiKey, loadImage } from "./store";
import type { ChatMessage, ImageRef, ReasoningEffort, ToolCall } from "./types";

let runtimeKey = "";
export function setRuntimeKey(value: string): void { runtimeKey = value.trim(); }
async function configuredApiKey(): Promise<string> {
  return runtimeKey || await getStoredApiKey() || process.env.DEEPSEEK_API_KEY?.trim() || "";
}
export async function hasApiKey(): Promise<boolean> { return Boolean(await configuredApiKey()); }
async function apiKey(): Promise<string> {
  const key = await configuredApiKey();
  if (!key) throw new Error("未配置 DeepSeek API Key，请在设置中填写，或设置 DEEPSEEK_API_KEY");
  return key;
}

export const toolDefinitions = [
  { name: "list_directory", description: "列出工作区内目录。", parameters: { type: "object", properties: { path: { type: "string", description: "相对工作区路径，根目录用 ." } }, required: ["path"] } },
  { name: "search_content", description: "在工作区内检索文本内容。", parameters: { type: "object", properties: { query: { type: "string" }, path: { type: "string", description: "检索范围，默认 ." } }, required: ["query"] } },
  { name: "read_file", description: "读取工作区内文本文件。修改已有文件前必须先读取。", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "write_file", description: "写入完整文本文件。已有文件必须先读取。", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "run_shell", description: "在工作目录执行 Shell 命令；每条命令都需要用户批准。用于运行测试和检查。", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "inspect_image", description: "使用视觉模型分析工作区内图片。", parameters: { type: "object", properties: { path: { type: "string" }, question: { type: "string" } }, required: ["path", "question"] } },
].map((item) => ({ type: "function", function: item }));

async function providerMessages(messages: ChatMessage[]): Promise<object[]> {
  return Promise.all(messages.map(async (message) => {
    if (message.role === "assistant") return { ...message, reasoning_content: message.reasoning_content ?? "" };
    if (message.role !== "user") return message;
    if (!message.images?.length) return { role: "user", content: message.content };
    const content: object[] = [{ type: "text", text: message.content }];
    for (const image of message.images) {
      const bytes = await loadImage(image.id);
      content.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${bytes.toString("base64")}` } });
    }
    return { role: "user", content };
  }));
}

function messageError(status: number, body: string): Error {
  if (status === 401 || status === 403) return new Error("API Key 无效或无权访问，请检查配置");
  if (status === 402) return new Error("API 额度不足，请检查账户余额");
  if (status === 429) return new Error("请求过于频繁，请稍后重试");
  return new Error(`模型服务返回 ${status}: ${body.slice(0, 300)}`);
}

async function request(body: object, signal: AbortSignal): Promise<Response> {
  const base = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${await apiKey()}` }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
      });
      if (response.ok) return response;
      const detail = await response.text();
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
        continue;
      }
      throw messageError(response.status, detail);
    } catch (error) {
      if (signal.aborted || attempt === 2 || /API Key|额度|模型服务返回 4\d\d/.test(String(error))) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600 * 2 ** attempt));
    }
  }
  throw new Error("模型服务暂不可用，请稍后重试");
}

export type ModelDelta = { content?: string; reasoning?: string };
export async function streamModel(messages: ChatMessage[], reasoningEffort: ReasoningEffort, signal: AbortSignal, onDelta: (delta: ModelDelta) => void, summary = "", extraInstruction = ""): Promise<ChatMessage & { role: "assistant" }> {
  const system = `你是本地代码生成 Agent。工作区由系统提供，先检查现有文件再修改。主动运行测试验证改动，失败后按错误修复，最多按设置重试。不要宣称未实际执行的命令已通过。工具失败时换策略或解释原因。最终用中文简述改动文件、原因、验证命令和结果。Shell 命令需要用户批准，拒绝后尊重决定。${summary ? `\n较早会话摘要：\n${summary}` : ""}${extraInstruction ? `\n${extraInstruction}` : ""}`;
  const response = await request({ model: "deepseek-flash", messages: [{ role: "system", content: system }, ...await providerMessages(messages)], tools: toolDefinitions, thinking: { type: reasoningEffort === "off" ? "disabled" : "enabled" }, ...(reasoningEffort === "off" ? {} : { reasoning_effort: reasoningEffort }), stream: true }, signal);
  if (!response.body) throw new Error("模型服务没有返回流式响应");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed = false;
  let content = "";
  let reasoning = "";
  const calls = new Map<number, ToolCall>();
  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === "[DONE]") { completed = true; return; }
    const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> } }[] };
    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) { content += delta.content; onDelta({ content: delta.content }); }
    if (delta.reasoning_content) { reasoning += delta.reasoning_content; onDelta({ reasoning: delta.reasoning_content }); }
    for (const part of delta.tool_calls || []) {
      const previous = calls.get(part.index) || { id: "", type: "function" as const, function: { name: "", arguments: "" } };
      previous.id += part.id || "";
      previous.function.name += part.function?.name || "";
      previous.function.arguments += part.function?.arguments || "";
      calls.set(part.index, previous);
    }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      handleLine(buffer.slice(0, lineEnd).trimEnd());
      buffer = buffer.slice(lineEnd + 1);
    }
  }
  if (buffer.trim()) handleLine(buffer.trim());
  if (!completed) throw new Error("模型流式响应中断，请重试；未完成的工具调用未执行");
  return { role: "assistant", content, reasoning_content: reasoning || null, ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call) } : {}) };
}

export async function completeText(prompt: string, signal: AbortSignal, image?: { bytes: Buffer; mime: string }): Promise<string> {
  const content = image ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:${image.mime};base64,${image.bytes.toString("base64")}` } }] : prompt;
  const response = await request({ model: "deepseek-flash", messages: [{ role: "user", content }], thinking: { type: "disabled" }, stream: false }, signal);
  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content || "";
}

export function estimateTokens(messages: ChatMessage[], summary = ""): number {
  const text = summary + JSON.stringify(messages);
  let nonAscii = 0;
  for (const character of text) if (character.charCodeAt(0) > 127) nonAscii += character.length;
  return Math.ceil((text.length - nonAscii) / 4 + nonAscii) + messages.reduce((sum, item) => sum + (item.role === "user" ? (item.images?.length || 0) * 1024 : 0), 0);
}

export function imageRefs(messages: ChatMessage[]): ImageRef[] {
  return messages.flatMap((message) => message.role === "user" ? message.images || [] : []);
}
