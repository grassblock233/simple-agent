import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DirectoryPickerBusyError, pickDirectory } from "../src/lib/directory-picker";

test("system directory picker handles selection, fallback, cancellation and single instance", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "simple-agent-picker-"));
  const folder = path.join(root, "中文 folder"); await mkdir(folder);
  const previousDisplay = process.env.DISPLAY;
  const previousWayland = process.env.WAYLAND_DISPLAY;
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DISPLAY = ":test"; process.env.DEEPSEEK_API_KEY = "must-not-reach-picker";
  const signal = () => new AbortController().signal;
  type Callback = (error: (Error & { code?: string | number }) | null, stdout: string) => void;
  try {
    await t.test("returns a canonical path with spaces and Chinese and omits API keys", async () => {
      const mock = t.mock.method(childProcess, "execFile", (command: string, args: string[], options: { env: NodeJS.ProcessEnv }, callback: Callback) => {
        assert.equal(command, "kdialog"); assert.equal(args[1], folder);
        assert.equal(options.env.DEEPSEEK_API_KEY, undefined);
        callback(null, `${folder}\n`);
      });
      try { assert.deepEqual(await pickDirectory(folder, signal()), { status: "selected", path: folder }); }
      finally { mock.mock.restore(); }
    });
    await t.test("missing or failed kdialog falls back to zenity", async () => {
      for (const code of ["ENOENT", "2"]) {
        const commands: string[] = [];
        const mock = t.mock.method(childProcess, "execFile", (command: string, _args: string[], _options: unknown, callback: Callback) => {
          commands.push(command);
          callback(command === "kdialog" ? Object.assign(new Error("failure"), { code }) : null, command === "zenity" ? `${folder}\n` : "");
        });
        try { assert.equal((await pickDirectory(undefined, signal())).status, "selected"); assert.deepEqual(commands, ["kdialog", "zenity"]); }
        finally { mock.mock.restore(); }
      }
    });
    await t.test("cancel does not launch a second picker", async () => {
      const mock = t.mock.method(childProcess, "execFile", (_command: string, _args: string[], _options: unknown, callback: Callback) => callback(Object.assign(new Error("cancel"), { code: 1 }), ""));
      try { assert.deepEqual(await pickDirectory(undefined, signal()), { status: "cancelled" }); assert.equal(mock.mock.callCount(), 1); }
      finally { mock.mock.restore(); }
    });
    await t.test("both tools unavailable returns fallback status", async () => {
      const mock = t.mock.method(childProcess, "execFile", (_command: string, _args: string[], _options: unknown, callback: Callback) => callback(Object.assign(new Error("missing"), { code: "ENOENT" }), ""));
      try { assert.deepEqual(await pickDirectory(undefined, signal()), { status: "unavailable" }); }
      finally { mock.mock.restore(); }
    });
    await t.test("abort is forwarded to the subprocess and duplicate requests are rejected", async () => {
      let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
      const mock = t.mock.method(childProcess, "execFile", (_command: string, _args: string[], options: { signal: AbortSignal }, callback: Callback) => {
        entered(); options.signal.addEventListener("abort", () => callback(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }), ""), { once: true });
      });
      try {
        const controller = new AbortController(); const pending = pickDirectory(undefined, controller.signal);
        await started;
        await assert.rejects(pickDirectory(undefined, signal()), DirectoryPickerBusyError);
        controller.abort(); assert.deepEqual(await pending, { status: "cancelled" });
      } finally { mock.mock.restore(); }
    });
    await t.test("no desktop environment returns unavailable without launching", async () => {
      delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
      const mock = t.mock.method(childProcess, "execFile", () => { throw new Error("must not launch"); });
      try { assert.deepEqual(await pickDirectory(undefined, signal()), { status: "unavailable" }); }
      finally { mock.mock.restore(); }
    });
  } finally {
    if (previousDisplay === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previousDisplay;
    if (previousWayland === undefined) delete process.env.WAYLAND_DISPLAY; else process.env.WAYLAND_DISPLAY = previousWayland;
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previousKey;
    await rm(root, { recursive: true, force: true });
  }
});
