import { runCommandOk } from "../lib/run-command.mts";

export async function git(cwd: string, args: string[]): Promise<void> {
  await runCommandOk("git", args, { cwd });
}

export async function revParse(cwd: string, rev: string): Promise<string> {
  const out = await runCommandOk("git", ["rev-parse", rev], { cwd });
  return out.trim();
}
