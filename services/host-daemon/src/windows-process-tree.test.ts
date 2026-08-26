import { describe, expect, it } from "vitest";

import { killWindowsProcessTree } from "./windows-process-tree.ts";

describe("Windows process-tree kill", () => {
  it("kills the pid and its descendant tree without a confirmation prompt", () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const killed = killWindowsProcessTree(4242, (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0 };
    });
    expect(calls).toEqual([
      {
        command: "taskkill",
        args: ["/PID", "4242", "/T", "/F"],
        options: { stdio: "ignore", windowsHide: true },
      },
    ]);
    expect(killed).toBe(true);
  });

  it("reports failure when taskkill exits non-zero", () => {
    const killed = killWindowsProcessTree(4242, () => ({ status: 128 }));
    expect(killed).toBe(false);
  });

  it("reports failure when taskkill.exe cannot be launched", () => {
    const killed = killWindowsProcessTree(4242, () => ({
      status: null,
      error: new Error("ENOENT"),
    }));
    expect(killed).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "reports failure against the real spawnSync path for a pid that cannot be killed",
    () => {
      // Exercises the default `run` (real spawnSync) without a mock. Off
      // Windows the taskkill binary itself is missing, so this reliably
      // fails without touching any real process; skipped on win32 because a
      // real host there could have a live process at this pid, and this
      // path would force-kill it and its descendant tree for real.
      expect(killWindowsProcessTree(999_999)).toBe(false);
    },
  );
});
