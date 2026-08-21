import type { ProcessRunner } from "./executor.ts";

type GitResult = { exitCode: number; stdout: string; stderr: string };

export async function runGit(
  runner: ProcessRunner,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<GitResult> {
  let stdout = "";
  let stderr = "";
  const result = await runner.run({
    argv: ["git", ...args],
    cwd,
    timeoutMs: 120_000,
    ...(signal ? { signal } : {}),
    onChunk: (c) => {
      if (c.stream === "stdout") {
        stdout += c.data;
      } else {
        stderr += c.data;
      }
    },
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout,
    stderr,
  };
}

export async function refetchConfiguredRemotes(
  runner: ProcessRunner,
  cwd: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const listed = await runGit(runner, cwd, ["remote"], signal);
  if (listed.exitCode !== 0) {
    return false;
  }
  const remotes = listed.stdout.split(/\r?\n/).filter((remote) => remote.length > 0);
  if (remotes.length === 0) {
    return false;
  }
  for (const remote of remotes) {
    const fetched = await runGit(runner, cwd, ["fetch", "--tags", "--refetch", remote], signal);
    if (fetched.exitCode !== 0) {
      return false;
    }
  }
  return true;
}
