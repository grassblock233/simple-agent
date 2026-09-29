import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gitStatus } from "../src/lib/git";

const exec = promisify(execFile);

test("git status handles repositories and ordinary directories", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "simple-agent-git-"));
  try {
    assert.deepEqual(await gitStatus(workspace), { isRepository: false, branch: "", branches: [], changedFiles: 0 });
    await exec("git", ["-C", workspace, "init", "-b", "main"]);
    await writeFile(path.join(workspace, "one.txt"), "one");
    const status = await gitStatus(workspace);
    assert.equal(status.isRepository, true);
    assert.equal(status.branch, "main");
    assert.equal(status.changedFiles, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
