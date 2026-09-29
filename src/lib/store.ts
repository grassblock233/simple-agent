import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Event, Session, SessionSettings } from "./types";

const dataDir = path.resolve(process.env.AGENT_DATA_DIR || ".data");
const sessionsDir = path.join(dataDir, "sessions");
const imagesDir = path.join(dataDir, "images");
const locks = new Map<string, Promise<void>>();

export function imagePath(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("图片 ID 无效");
  return path.join(imagesDir, id);
}

export async function saveImage(id: string, bytes: Buffer): Promise<void> {
  await mkdir(imagesDir, { recursive: true });
  await writeFile(imagePath(id), bytes, { flag: "wx" });
}

export async function loadImage(id: string): Promise<Buffer> {
  return readFile(imagePath(id));
}

async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await fn(); }
  finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

export function withWorkspaceLock<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  return locked(`workspace:${workspace}`, fn);
}

export function withSessionLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  return locked(`session:${id}`, fn);
}

export async function validateWorkspace(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new Error("请输入工作目录的绝对路径");
  const resolved = await realpath(input);
  if (!(await stat(resolved)).isDirectory()) throw new Error("工作目录不是文件夹");
  return resolved;
}

const defaults: SessionSettings = { thinking: true, maxAttempts: 3, maxToolRounds: 16, compression: true, threshold: 0.75 };

function sessionFile(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("会话 ID 无效");
  return path.join(sessionsDir, `${id}.json`);
}

export async function createSession(workspace: string): Promise<Session> {
  const now = new Date().toISOString();
  const session: Session = { id: randomUUID(), title: "新会话", workspace: await validateWorkspace(workspace), createdAt: now, updatedAt: now, settings: { ...defaults }, messages: [], contextStart: 0, summary: "", events: [] };
  await saveSession(session);
  return session;
}

export async function saveSession(session: Session): Promise<void> {
  await mkdir(sessionsDir, { recursive: true });
  session.updatedAt = new Date().toISOString();
  const file = sessionFile(session.id);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(session));
  await rename(temporary, file);
}

export async function getSession(id: string): Promise<Session | null> {
  try { return JSON.parse(await readFile(sessionFile(id), "utf8")) as Session; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

export async function listSessions(): Promise<Session[]> {
  await mkdir(sessionsDir, { recursive: true });
  const names = (await readdir(sessionsDir)).filter((name) => /^[a-f0-9-]{36}\.json$/.test(name));
  const items = await Promise.all(names.map(async (name) => getSession(name.slice(0, -5))));
  return items.filter((item): item is Session => Boolean(item)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteSession(id: string): Promise<void> {
  await rm(sessionFile(id), { force: true });
}

export function makeEvent(type: Event["type"], values: Partial<Event> = {}): Event {
  return { id: randomUUID(), at: new Date().toISOString(), type, ...values };
}

export function contextBudget(): number {
  const value = Number(process.env.CONTEXT_TOKEN_BUDGET || 64000);
  return Number.isFinite(value) ? Math.max(4000, value) : 64000;
}
