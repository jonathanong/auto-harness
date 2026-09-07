/** Signal a process group, falling back to a direct-pid signal when the group is gone. */
export function killGroupOrPid(
  kill: typeof process.kill,
  pid: number,
  signal: NodeJS.Signals,
): void {
  try {
    kill(-pid, signal);
    return;
  } catch {
    // Fall through — e.g. the group leader already reaped.
  }
  try {
    kill(pid, signal);
  } catch {
    // A concurrent exit already reaped it.
  }
}
