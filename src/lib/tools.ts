import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { listDirectory, MAX_IMAGE_BYTES, readText, searchText, validateImage, workspacePath, writeText } from "./files";
import { completeText } from "./model";
import { dangerousCommand, executeShell } from "./shell";
import { withWorkspaceLock } from "./store";
import type { Session, ToolCall } from "./types";

export type ToolContext = {
  session: Session;
  signal: AbortSignal;
  readPaths: Set<string>;
  requestApproval: (command: string) => Promise<boolean>;
};

function argsOf(call: ToolCall): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(call.function.arguments); }
  catch { throw new Error("工具参数不是有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工具参数必须是对象");
  return value as Record<string, unknown>;
}

function stringArg(args: Record<string, unknown>, name: string, optional = false): string {
  const value = args[name];
  if (optional && value === undefined) return "";
  if (typeof value !== "string") throw new Error(`缺少或错误的参数：${name}`);
  return value;
}

export async function runTool(call: ToolCall, context: ToolContext): Promise<string> {
  const args = argsOf(call);
  const root = context.session.workspace;
  switch (call.function.name) {
    case "list_directory": return withWorkspaceLock(root, () => listDirectory(root, stringArg(args, "path")));
    case "search_content": return withWorkspaceLock(root, () => searchText(root, stringArg(args, "query"), stringArg(args, "path", true) || "."));
    case "read_file": {
      const requested = stringArg(args, "path");
      return withWorkspaceLock(root, async () => {
        const value = await readText(root, requested);
        context.readPaths.add(await workspacePath(root, requested));
        return value;
      });
    }
    case "write_file": {
      const requested = stringArg(args, "path");
      return withWorkspaceLock(root, async () => {
        const file = await workspacePath(root, requested, true);
        try {
          await stat(file);
          if (!context.readPaths.has(file)) throw new Error("修改已有文件前必须先读取该文件");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return `已写入 ${await writeText(root, requested, stringArg(args, "content"))}`;
      });
    }
    case "run_shell": {
      const command = stringArg(args, "command");
      const blocked = dangerousCommand(command);
      if (blocked) throw new Error(blocked);
      const approved = await context.requestApproval(command);
      if (!approved) throw new Error("用户拒绝执行此 Shell 命令");
      if (context.signal.aborted) throw new Error("执行已停止");
      const result = await withWorkspaceLock(root, () => executeShell(command, root, context.signal));
      if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error(JSON.stringify(result));
      return JSON.stringify(result);
    }
    case "inspect_image": {
      const requested = stringArg(args, "path");
      const question = stringArg(args, "question");
      const { file, bytes } = await withWorkspaceLock(root, async () => {
        const file = await workspacePath(root, requested);
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new Error("图片不是普通文件或超过 8 MiB");
        const bytes = await readFile(file);
        return { file, bytes };
      });
      const mime = await validateImage(bytes);
      return `图片 ${path.relative(root, file)} 分析结果：${await completeText(question, context.signal, { bytes, mime })}`;
    }
    default: throw new Error(`未知工具：${call.function.name}`);
  }
}
