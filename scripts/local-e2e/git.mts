import { spawnSync } from "node:child_process";

export function git(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
}

export function revParse(cwd: string, rev: string): string {
  const r = spawnSync("git", ["rev-parse", rev], { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`rev-parse failed: ${r.stderr}`);
  }
  return r.stdout.trim();
}
