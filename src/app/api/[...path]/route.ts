import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { isRunning, resolveApproval, runAgent, stopRun } from "@/lib/agent";
import { detectImage, MAX_IMAGE_BYTES, validateImage } from "@/lib/files";
import { gitStatus } from "@/lib/git";
import { estimateTokens, hasApiKey, setRuntimeKey } from "@/lib/model";
import { checkOrigin } from "@/lib/origin";
import { contextBudget, createSession, deleteSession, getAppSettings, getProject, getSession, imagePath, listProjects, listSessions, saveImage, saveSession, updateAppSettings, updateProject, updateSessionsForWorkspace, validateWorkspace } from "@/lib/store";
import type { ImageRef, LiveEvent, SessionSettings } from "@/lib/types";

export const runtime = "nodejs";
type Params = { params: Promise<{ path: string[] }> };

function jsonError(error: unknown, status = 400): NextResponse {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

export async function GET(request: NextRequest, context: Params): Promise<Response> {
  try {
    const parts = (await context.params).path;
    if (parts[0] === "settings" && parts.length === 1) return NextResponse.json(await getAppSettings());
    if (parts[0] === "config") return NextResponse.json({ hasApiKey: hasApiKey(), model: "deepseek-flash" });
    if (parts[0] === "sessions" && parts.length === 1) return NextResponse.json((await listSessions()).map(({ id, title, workspace, createdAt, updatedAt, messages, pinned, archived }) => ({ id, title, workspace, createdAt, updatedAt, pinned, archived, hasMessages: messages.some((message) => message.role === "user") })));
    if (parts[0] === "projects" && parts.length === 1) {
      const sessions = await listSessions();
      return NextResponse.json(await listProjects(sessions.map((session) => session.workspace)));
    }
    if (parts[0] === "sessions" && parts.length === 2) {
      const session = await getSession(parts[1]);
      if (!session) return jsonError("会话不存在", 404);
      const running = isRunning(parts[1]);
      if (!running) {
        let interrupted = false;
        for (const event of session.events) {
          if (event.status === "pending") {
            event.status = event.type === "tool" ? "failed" : "denied";
            event.result ||= "服务中断，工具状态未知；继续前请检查工作区。";
            interrupted = true;
          }
        }
        if (interrupted) await saveSession(session);
      }
      return NextResponse.json({ ...session, running, occupancy: estimateTokens(session.messages.slice(session.contextStart), session.summary) / contextBudget(), contextBudget: contextBudget() });
    }
    if (parts[0] === "git" && parts[1] === "status") {
      const workspace = request.nextUrl.searchParams.get("workspace");
      if (!workspace) throw new Error("缺少工作目录");
      return NextResponse.json(await gitStatus(workspace));
    }
    if (parts[0] === "fs" && parts[1] === "browse") {
      const directory = path.resolve(request.nextUrl.searchParams.get("path") || process.cwd());
      const info = await stat(directory);
      if (!info.isDirectory()) throw new Error("目标不是目录");
      const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
      return NextResponse.json({ path: directory, parent: path.dirname(directory), entries });
    }
    if (parts[0] === "images" && parts.length === 2) {
      const bytes = await readFile(imagePath(parts[1]));
      const mime = detectImage(bytes);
      if (!mime) throw new Error("图片格式无效");
      return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "Cache-Control": "private, max-age=3600" } });
    }
    return jsonError("接口不存在", 404);
  } catch (error) { return jsonError(error); }
}

export async function POST(request: NextRequest, context: Params): Promise<Response> {
  try {
    checkOrigin(request.headers, request.nextUrl.protocol);
    const parts = (await context.params).path;
    if (parts[0] === "config") {
      const body = await request.json() as { apiKey?: unknown };
      if (typeof body.apiKey !== "string") throw new Error("API Key 格式无效");
      setRuntimeKey(body.apiKey);
      return NextResponse.json({ hasApiKey: hasApiKey() });
    }
    if (parts[0] === "sessions" && parts.length === 1) {
      const body = await request.json() as { workspace?: unknown };
      if (typeof body.workspace !== "string") throw new Error("请选择工作目录");
      return NextResponse.json(await createSession(body.workspace));
    }
    if (parts[0] === "images" && parts.length === 1) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("请选择图片");
      if (file.size > MAX_IMAGE_BYTES) throw new Error("图片不能超过 8 MiB");
      const bytes = Buffer.from(await file.arrayBuffer());
      const mime = await validateImage(bytes);
      const id = randomUUID();
      await saveImage(id, bytes);
      return NextResponse.json({ id, name: file.name.slice(0, 150), mime } satisfies ImageRef);
    }
    if (parts[0] === "approvals" && parts.length === 2) {
      const body = await request.json() as { approved?: unknown };
      if (typeof body.approved !== "boolean") throw new Error("审批值无效");
      return resolveApproval(parts[1], body.approved) ? NextResponse.json({ ok: true }) : jsonError("审批已过期", 404);
    }
    if (parts[0] === "projects" && parts.length === 1) {
      const body = await request.json() as { action?: unknown; workspace?: unknown; name?: unknown; pinned?: unknown };
      if (typeof body.workspace !== "string" || !body.workspace) throw new Error("缺少项目目录");
      const workspace = await validateWorkspace(body.workspace);
      const action = body.action;
      if (action === "rename") return NextResponse.json(await updateProject(workspace, { name: typeof body.name === "string" ? body.name : "" }));
      if (action === "pin") return NextResponse.json(await updateProject(workspace, { pinned: body.pinned === true }));
      if (action === "archive") return NextResponse.json({ ...(await getProject(workspace)), archived: await updateSessionsForWorkspace(workspace, { archived: true }) });
      if (action === "remove") {
        await updateSessionsForWorkspace(workspace, { archived: true });
        return NextResponse.json(await updateProject(workspace, { hidden: true }));
      }
      if (action === "restore") {
        await updateSessionsForWorkspace(workspace, { archived: false });
        return NextResponse.json(await updateProject(workspace, { hidden: false }));
      }
      if (action === "open") {
        const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        const child = spawn(command, [workspace], { detached: true, stdio: "ignore" });
        child.on("error", () => { /* The desktop opener may be unavailable in headless environments. */ });
        child.unref();
        return NextResponse.json({ ok: true });
      }
      throw new Error("项目操作无效");
    }
    if (parts[0] === "sessions" && parts.length === 3 && parts[2] === "stop") return NextResponse.json({ stopped: stopRun(parts[1]) });
    if (parts[0] === "sessions" && parts.length === 3 && parts[2] === "runs") {
      if (isRunning(parts[1])) return jsonError("此会话已有运行中的任务", 409);
      const body = await request.json() as { text?: unknown; images?: unknown };
      if (typeof body.text !== "string" || !Array.isArray(body.images) || body.images.length > 4) throw new Error("消息格式无效");
      const images = body.images as ImageRef[];
      for (const image of images) {
        if (!image || typeof image.id !== "string" || typeof image.mime !== "string" || typeof image.name !== "string") throw new Error("图片引用无效");
        const bytes = await readFile(imagePath(image.id));
        if (detectImage(bytes) !== image.mime) throw new Error("图片引用与格式不匹配");
      }
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (event: LiveEvent) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch {} };
          void runAgent(parts[1], body.text as string, images, emit).catch((error) => {
            emit({ type: "event", event: { id: randomUUID(), at: new Date().toISOString(), type: "error", text: String(error), status: "failed" } });
          }).finally(() => { try { controller.close(); } catch {} });
        },
        cancel() { stopRun(parts[1]); },
      });
      return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Content-Type-Options": "nosniff" } });
    }
    return jsonError("接口不存在", 404);
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: NextRequest, context: Params): Promise<Response> {
  try {
    checkOrigin(request.headers, request.nextUrl.protocol);
    const parts = (await context.params).path;
    if (parts[0] === "settings" && parts.length === 1) {
      const body = await request.json();
      return NextResponse.json(await updateAppSettings(body?.sessionDefaults));
    }
    if (parts[0] !== "sessions" || parts.length !== 2) return jsonError("接口不存在", 404);
    if (isRunning(parts[1])) return jsonError("运行时不能修改设置", 409);
    const session = await getSession(parts[1]);
    if (!session) return jsonError("会话不存在", 404);
    const body = await request.json() as Partial<SessionSettings> & { pinned?: unknown; archived?: unknown };
    if (["off", "low", "high", "max"].includes(body.reasoningEffort || "")) session.settings.reasoningEffort = body.reasoningEffort!;
    if (typeof body.compression === "boolean") session.settings.compression = body.compression;
    if (typeof body.maxAttempts === "number" && Number.isInteger(body.maxAttempts)) session.settings.maxAttempts = Math.max(1, Math.min(10, body.maxAttempts));
    if (typeof body.threshold === "number") session.settings.threshold = Math.max(0.1, Math.min(0.95, body.threshold));
    if (typeof body.pinned === "boolean") session.pinned = body.pinned;
    if (typeof body.archived === "boolean") {
      session.archived = body.archived;
      if (!body.archived) await updateProject(session.workspace, { hidden: false });
    }
    await saveSession(session);
    return NextResponse.json(session);
  } catch (error) { return jsonError(error); }
}

export async function DELETE(request: NextRequest, context: Params): Promise<Response> {
  try {
    checkOrigin(request.headers, request.nextUrl.protocol);
    const parts = (await context.params).path;
    if (parts[0] !== "sessions" || parts.length !== 2) return jsonError("接口不存在", 404);
    if (isRunning(parts[1])) return jsonError("请先停止运行中的任务", 409);
    await deleteSession(parts[1]);
    return NextResponse.json({ ok: true });
  } catch (error) { return jsonError(error); }
}
