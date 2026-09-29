import { spawn } from "node:child_process";

export type ShellResult = { exitCode: number | null; output: string; timedOut: boolean; truncated: boolean };

export function dangerousCommand(command: string): string | null {
  const patterns: [RegExp, string][] = [
    [/\b(?:sudo|su|doas)\b/i, "提权命令已被拦截"],
    [/\b(?:shutdown|reboot|poweroff|halt)\b/i, "关机或重启命令已被拦截"],
    [/\brm\s+[^\n]*-[^\n]*[rf][^\n]*\s+\/?(?:\s|$)/i, "递归删除危险路径已被拦截"],
    [/\b(?:curl|wget|scp|rsync|nc|netcat|ssh)\b/i, "网络传输命令已被拦截"],
  ];
  return patterns.find(([pattern]) => pattern.test(command))?.[1] || null;
}

export async function executeShell(command: string, cwd: string, signal: AbortSignal): Promise<ShellResult> {
  if (!command || command.length > 4000) throw new Error("命令长度必须在 1–4000 字符内");
  const denied = dangerousCommand(command);
  if (denied) throw new Error(denied);
  const timeout = Math.max(1000, Math.min(120000, Number(process.env.SHELL_TIMEOUT_MS || 30000)));
  const maxOutput = 24000;
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TMPDIR", "TERM", "CI"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let truncated = false;
    let timedOut = false;
    const stop = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const append = (chunk: Buffer) => {
      const remaining = maxOutput - output.length;
      if (remaining <= 0) { truncated = true; stop(); return; }
      const value = chunk.toString("utf8");
      output += value.slice(0, remaining);
      if (value.length > remaining) { truncated = true; stop(); }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", reject);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal.addEventListener("abort", stop, { once: true });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ exitCode, output, timedOut, truncated });
    });
  });
}
