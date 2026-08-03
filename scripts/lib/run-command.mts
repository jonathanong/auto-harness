import { spawn } from "node:child_process";

/**
 * Async child process helper (shell: false). Prefer this over spawnSync so the
 * event loop stays free for in-process servers and concurrent work.
 */
export function runCommand(
  command: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/** Like runCommand but throws when exit status is non-zero. Returns stdout. */
export async function runCommandOk(
  command: string,
  args: string[] = [],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const r = await runCommand(command, args, options);
  if (r.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}
