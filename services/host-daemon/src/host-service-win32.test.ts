import { describe, expect, it } from "vitest";

import { installHostService, uninstallHostService } from "./host-service.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";

describe("install-service win32", () => {
  it("registers a current-user logon task", () => {
    const fs = seededFs();
    const spawn = recorder();
    expect(installHostService(baseOpts({ platform: "win32", fs, run: spawn.run }))).toBe(0);
    expect(fs.modes.get("/Users/op/AppData/Roaming/auto-harness/host-daemon.env")).toBe(0o600);
    const cmd = fs.files.get("/Users/op/AppData/Roaming/auto-harness/run-host-daemon.cmd");
    expect(cmd).toContain("HARNESS_ENV_FILE=");
    expect(cmd).not.toMatch(/LOCALSYSTEM|NSSM/i);
    expect(spawn.calls[0]?.args).toEqual(
      expect.arrayContaining(["/Create", "/SC", "ONLOGON", "/RL", "LIMITED"]),
    );
    expect(spawn.calls[0]?.args.join(" ")).not.toMatch(/SYSTEM/);
    expect(spawn.calls[1]?.args).toEqual(["/Run", "/TN", "AutoHarnessHostDaemon"]);
  });

  it("keeps env, reports create failure, and warns when /Run fails", () => {
    const envPath = "/Users/op/AppData/Roaming/auto-harness/host-daemon.env";
    const fs = seededFs({ [envPath]: "KEEP=1\n" });
    const logs: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "win32",
          fs,
          log: (m) => logs.push(m),
          run: (_c, args) =>
            args[0] === "/Run"
              ? { status: 1, stdout: "busy", stderr: "" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(envPath)).toBe("KEEP=1\n");
    expect(logs.join("\n")).toMatch(/schtasks \/Run failed/);
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          error: (m) => errors.push(m),
          run: () => ({ status: 1, stdout: "", stderr: "denied" }),
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/Create/);
  });

  it("deletes the task and wrapper, treating a missing task as success", () => {
    const cmdPath = "/Users/op/AppData/Roaming/auto-harness/run-host-daemon.cmd";
    const fs = seededFs({ [cmdPath]: "@echo off\n" });
    expect(
      uninstallHostService(
        baseOpts({
          platform: "win32",
          fs,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(fs.files.has(cmdPath)).toBe(false);
    expect(
      uninstallHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          run: () => ({ status: 1, stdout: "does not exist", stderr: "" }),
        }),
      ),
    ).toBe(0);
    const errors: string[] = [];
    expect(
      uninstallHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          error: (m) => errors.push(m),
          run: () => ({ status: 1, stdout: "", stderr: "access denied" }),
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/Delete/);
  });
});
