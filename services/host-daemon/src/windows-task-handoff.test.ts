import { describe, expect, it } from "vitest";

import { requestWindowsTaskRestart } from "./windows-task-handoff.ts";

describe("Windows scheduled-task restart handoff", () => {
  it("detaches the fixed task stop-and-start sequence before the daemon can exit", () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    let unref = 0;
    requestWindowsTaskRestart((command, args, options) => {
      calls.push({ command, args, options });
      return {
        unref: () => {
          unref += 1;
        },
      };
    });
    expect(calls).toEqual([
      {
        command: "cmd.exe",
        args: [
          "/d",
          "/s",
          "/c",
          'schtasks /End /TN "AutoHarnessHostDaemon" >NUL 2>&1 & schtasks /Run /TN "AutoHarnessHostDaemon"',
        ],
        options: { detached: true, stdio: "ignore", windowsHide: true },
      },
    ]);
    expect(unref).toBe(1);
  });
});
