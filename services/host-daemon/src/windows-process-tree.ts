import { spawnSync } from "node:child_process";

export type WindowsProcessTreeKill = (pid: number) => boolean;

type TaskkillResult = { status: number | null; error?: Error };

type TaskkillRun = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: true },
) => TaskkillResult;

const runTaskkill: TaskkillRun = (command, args, options) => spawnSync(command, args, options);

/**
 * Kill a Windows process and its full descendant tree. Windows child
 * processes never join a POSIX process group -- `SpawnProcessRunner` only
 * sets `detached` on non-Windows platforms -- so a plain `child.kill()`
 * only reaches the direct child. That under-kills whenever the direct
 * child is itself a launcher: see #348, where a `cmd.exe` launcher exited
 * while its `node.exe` descendant kept running after cancel/timeout and
 * continued to hold inherited pipes open. `/T` reaches the whole tree;
 * `/F` forces termination without a confirmation prompt.
 *
 * `spawnSync` never throws on a failed launch or a non-zero exit -- it
 * reports both on the returned object -- so the result is inspected and a
 * false return tells the caller to fall back to `child.kill()` rather than
 * silently leaving the tree running.
 */
export function killWindowsProcessTree(pid: number, run: TaskkillRun = runTaskkill): boolean {
  const result = run("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.error === undefined && result.status === 0;
}
