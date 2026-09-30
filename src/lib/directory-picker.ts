import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import os from "node:os";
import { validateWorkspace } from "./store";
import type { DirectorySelectionResult } from "./types";

let active = false;
export class DirectoryPickerBusyError extends Error {
  constructor() { super("目录选择器已打开，请先完成当前选择"); }
}

export async function pickDirectory(initialPath: string | undefined, signal: AbortSignal): Promise<DirectorySelectionResult> {
  if (signal.aborted) return { status: "cancelled" };
  if (active) throw new DirectoryPickerBusyError();
  if (process.platform !== "linux" || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return { status: "unavailable" };
  active = true;
  try {
    let start = os.homedir();
    if (initialPath) {
      try { start = await validateWorkspace(initialPath); } catch { /* A deleted starting directory should not prevent selection. */ }
    }
    const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
    for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_CURRENT_DESKTOP", "QT_QPA_PLATFORM"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    for (const [command, args] of [
      ["kdialog", ["--getexistingdirectory", start, "--title", "选择项目文件夹"]],
      ["zenity", ["--file-selection", "--directory", "--title=选择项目文件夹", `--filename=${start}/`]],
    ] as const) {
      if (signal.aborted) return { status: "cancelled" };
      const result = await new Promise<{ error: ExecFileException | null; stdout: string }>(resolve => {
        execFile(command, [...args], { env, signal, timeout: 120000, maxBuffer: 65536 }, (error, stdout) => resolve({ error, stdout }));
      });
      if (signal.aborted || result.error?.code === "ABORT_ERR") return { status: "cancelled" };
      if (result.error) {
        if (Number(result.error.code) === 1) return { status: "cancelled" };
        continue;
      }
      const selected = result.stdout.replace(/\r?\n$/, "");
      if (!selected) return { status: "cancelled" };
      return { status: "selected", path: await validateWorkspace(selected) };
    }
    return { status: "unavailable" };
  } finally { active = false; }
}
