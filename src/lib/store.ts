import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppSettings, Event, Project, Session, SessionSettings } from "./types";

const dataDir = path.resolve(process.env.AGENT_DATA_DIR || ".data");
const sessionsDir = path.join(dataDir, "sessions");
const imagesDir = path.join(dataDir, "images");
const projectsFile = path.join(dataDir, "projects.json");
const settingsFile = path.join(dataDir, "settings.json");
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

const defaults: SessionSettings = { reasoningEffort: "high", maxAttempts: 3, compression: true, threshold: 0.75 };

function validateDefaults(value: unknown): Partial<SessionSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("默认设置格式无效");
  const patch = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(patch)) {
    if (key === "reasoningEffort" && ["off", "low", "high", "max"].includes(String(item))) continue;
    if (key === "compression" && typeof item === "boolean") continue;
    if (key === "maxAttempts" && typeof item === "number" && Number.isInteger(item) && item >= 1 && item <= 10) continue;
    if (key === "threshold" && typeof item === "number" && Number.isFinite(item) && item >= 0.1 && item <= 0.95) continue;
    throw new Error(`默认设置 ${key} 无效`);
  }
  return patch as Partial<SessionSettings>;
}

export async function getAppSettings(): Promise<AppSettings> {
  try {
    const stored = JSON.parse(await readFile(settingsFile, "utf8")) as AppSettings;
    return { sessionDefaults: { ...defaults, ...validateDefaults(stored.sessionDefaults) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sessionDefaults: { ...defaults } };
    throw error;
  }
}

export async function updateAppSettings(value: unknown): Promise<AppSettings> {
  const patch = validateDefaults(value);
  return locked("app-settings", async () => {
    const current = await getAppSettings();
    const next = { sessionDefaults: { ...current.sessionDefaults, ...patch } };
    await mkdir(dataDir, { recursive: true });
    const temporary = `${settingsFile}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next));
    await rename(temporary, settingsFile);
    return next;
  });
}

type StoredProject = Project;

async function readProjects(): Promise<StoredProject[]> {
  try {
    const value = JSON.parse(await readFile(projectsFile, "utf8")) as unknown;
    return Array.isArray(value) ? value.filter((item): item is StoredProject => Boolean(item && typeof item === "object" && typeof (item as StoredProject).workspace === "string")) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeProjects(projects: StoredProject[]): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const temporary = `${projectsFile}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(projects));
  await rename(temporary, projectsFile);
}

function defaultProject(workspace: string): Project {
  return { workspace, name: path.basename(workspace) || workspace, pinned: false, hidden: false };
}

export async function getProject(workspace: string): Promise<Project> {
  const resolved = path.resolve(workspace);
  const project = (await readProjects()).find((item) => item.workspace === resolved);
  return { ...defaultProject(resolved), ...project, workspace: resolved };
}

export async function listProjects(workspaces: string[] = []): Promise<Project[]> {
  const stored = await readProjects();
  const paths = Array.from(new Set([...stored.map((item) => item.workspace), ...workspaces.map((item) => path.resolve(item))]));
  return paths.map((workspace) => ({ ...defaultProject(workspace), ...stored.find((item) => item.workspace === workspace), workspace }));
}

export async function updateProject(workspace: string, patch: Partial<Pick<Project, "name" | "pinned" | "hidden">>): Promise<Project> {
  const resolved = path.resolve(workspace);
  const projects = await readProjects();
  const current = { ...defaultProject(resolved), ...projects.find((item) => item.workspace === resolved) };
  const next = { ...current, ...patch, workspace: resolved, name: patch.name !== undefined ? patch.name.trim() || path.basename(resolved) : current.name };
  await writeProjects([...projects.filter((item) => item.workspace !== resolved), next]);
  return next;
}

function normalizeSettings(value: Partial<SessionSettings> & { thinking?: boolean }): SessionSettings {
  const reasoningEffort = ["off", "low", "high", "max"].includes(value.reasoningEffort || "")
    ? value.reasoningEffort! : value.thinking === false ? "off" : "high";
  return {
    reasoningEffort,
    maxAttempts: value.maxAttempts ?? defaults.maxAttempts,
    compression: value.compression ?? defaults.compression,
    threshold: value.threshold ?? defaults.threshold,
  };
}

function sessionFile(id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("会话 ID 无效");
  return path.join(sessionsDir, `${id}.json`);
}

export async function createSession(workspace: string): Promise<Session> {
  const now = new Date().toISOString();
  const validatedWorkspace = await validateWorkspace(workspace);
  const session: Session = { id: randomUUID(), title: "新会话", workspace: validatedWorkspace, createdAt: now, updatedAt: now, settings: { ...(await getAppSettings()).sessionDefaults }, messages: [], contextStart: 0, summary: "", events: [], pinned: false, archived: false };
  await getProject(validatedWorkspace);
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
  try {
    const session = JSON.parse(await readFile(sessionFile(id), "utf8")) as Session & { settings: SessionSettings & { thinking?: boolean; maxToolRounds?: number } };
    session.settings = normalizeSettings(session.settings);
    session.pinned = session.pinned === true;
    session.archived = session.archived === true;
    return session;
  }
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

export async function updateSessionsForWorkspace(workspace: string, patch: Pick<Session, "archived">): Promise<number> {
  const sessions = await listSessions();
  let count = 0;
  for (const session of sessions.filter((item) => item.workspace === path.resolve(workspace))) {
    session.archived = patch.archived;
    await saveSession(session);
    count += 1;
  }
  return count;
}

export function makeEvent(type: Event["type"], values: Partial<Event> = {}): Event {
  return { id: randomUUID(), at: new Date().toISOString(), type, ...values };
}

export function contextBudget(): number {
  const value = Number(process.env.CONTEXT_TOKEN_BUDGET || 1000000);
  return Number.isFinite(value) ? Math.min(1000000, Math.max(4000, value)) : 1000000;
}
