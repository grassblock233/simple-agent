import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validateWorkspace } from "./store";

const exec = promisify(execFile);

export type GitStatus = { isRepository: boolean; branch: string; branches: string[]; changedFiles: number };

async function git(workspace: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-C", workspace, ...args], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return stdout;
}

export async function gitStatus(workspace: string): Promise<GitStatus> {
  const directory = await validateWorkspace(workspace);
  try {
    await git(directory, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { isRepository: false, branch: "", branches: [], changedFiles: 0 };
  }
  const [branchResult, branchesResult, changesResult] = await Promise.all([
    git(directory, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    git(directory, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]),
    git(directory, ["status", "--porcelain=v1", "--untracked-files=normal"]),
  ]);
  const branch = branchResult.trim() || "分离 HEAD";
  const branches = branchesResult.trim().split("\n").filter(Boolean);
  const changedFiles = changesResult.split("\n").filter(Boolean).length;
  return { isRepository: true, branch, branches, changedFiles };
}
