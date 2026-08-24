import { spawn } from "node:child_process";

import { WINDOWS_TASK_NAME } from "./host-service-templates.ts";

type WindowsHandoffChild = {
  unref: () => void;
};

type WindowsHandoffSpawn = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore"; windowsHide: true },
) => WindowsHandoffChild;

const spawnWindowsHandoff: WindowsHandoffSpawn = (command, args, options) =>
  spawn(command, args, options);

/**
 * Give the scheduled task restart to an independent process before ending the
 * running daemon. Executing `schtasks /End` in the daemon would terminate it
 * before its following `/Run` can be relied on. The command contains only the
 * fixed, installer-owned task name; no operator or update value is interpolated.
 */
export function requestWindowsTaskRestart(run: WindowsHandoffSpawn = spawnWindowsHandoff): void {
  const child = run(
    "cmd.exe",
    [
      "/d",
      "/s",
      "/c",
      `schtasks /End /TN "${WINDOWS_TASK_NAME}" >NUL 2>&1 & schtasks /Run /TN "${WINDOWS_TASK_NAME}"`,
    ],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
}
