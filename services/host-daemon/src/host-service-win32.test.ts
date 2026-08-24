/* eslint-disable max-lines -- Windows service outcomes share one filesystem fixture. */
import { describe, expect, it } from "vitest";

import { installHostService, uninstallHostService } from "./host-service.ts";
import { resolveHostService } from "./host-service-io.ts";
import { statusWin32 } from "./host-service-win32.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";

describe("install-service win32", () => {
  it("registers a current-user logon task", () => {
    const fs = seededFs();
    const spawn = recorder({
      "schtasks /End /TN AutoHarnessHostDaemon": {
        status: 1,
        stdout: "",
        stderr: "ERROR: The task is not running",
      },
    });
    expect(installHostService(baseOpts({ platform: "win32", fs, run: spawn.run }))).toBe(0);
    expect(fs.modes.get("/Users/op/AppData/Roaming/auto-harness/host-daemon.env")).toBe(0o600);
    const cmd = fs.files.get("/Users/op/AppData/Roaming/auto-harness/run-host-daemon.cmd");
    expect(cmd).toContain("HARNESS_ENV_FILE=");
    expect(cmd).not.toMatch(/LOCALSYSTEM|NSSM/i);
    expect(spawn.calls[0]?.args).toEqual(["/End", "/TN", "AutoHarnessHostDaemon"]);
    expect(spawn.calls[1]?.args).toEqual(
      expect.arrayContaining(["/Create", "/SC", "ONLOGON", "/RL", "LIMITED"]),
    );
    expect(spawn.calls[1]?.args.join(" ")).not.toMatch(/SYSTEM/);
    expect(spawn.calls[2]?.args).toEqual(["/Run", "/TN", "AutoHarnessHostDaemon"]);
  });

  it("keeps env, reports create failure, and warns when /Run fails", () => {
    const envPath = "/Users/op/AppData/Roaming/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\n",
    });
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
    expect(fs.files.get(envPath)).toContain("HARNESS_API_KEY=secret");
    expect(logs.join("\n")).toMatch(/schtasks \/Run failed/);
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          error: (m) => errors.push(m),
          run: (_c, args) =>
            args[0] === "/Create"
              ? { status: 1, stdout: "", stderr: "denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/Create/);
  });

  it("merges exported execution settings into an existing env", () => {
    const envPath = "/Users/op/AppData/Roaming/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\nOTHER=keep\n",
    });
    expect(
      installHostService(
        baseOpts({
          platform: "win32",
          fs,
          env: {
            HARNESS_EXECUTION_PROFILES: "C:/auto-harness/profiles.json",
            HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "5",
          },
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(envPath)).toContain(
      "HARNESS_EXECUTION_PROFILES=C:/auto-harness/profiles.json",
    );
    expect(fs.files.get(envPath)).toContain("HARNESS_MAX_CONCURRENT_ASSIGNMENTS=5");
    expect(fs.files.get(envPath)).toContain("HARNESS_API_KEY=secret");
    expect(fs.files.get(envPath)).toContain("OTHER=keep");
  });

  it("fails install when /End fails for a reason other than not running", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          error: (m) => errors.push(m),
          run: (_c, args) =>
            args[0] === "/End"
              ? { status: 1, stdout: "", stderr: "access denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/End/);
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
          run: (_c, args) =>
            args[0] === "/Delete"
              ? { status: 1, stdout: "", stderr: "access denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/Delete/);
    const endErrors: string[] = [];
    expect(
      uninstallHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          error: (m) => endErrors.push(m),
          run: (_c, args) =>
            args[0] === "/End"
              ? { status: 1, stdout: "", stderr: "access denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(endErrors.join("\n")).toMatch(/End/);
  });
});

describe("status win32", () => {
  it("maps the exact scheduled task status", () => {
    const calls: string[][] = [];
    const result = statusWin32(
      resolveHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          run: (_command, args) => {
            calls.push(args);
            return { status: 0, stdout: "Status: Running\n", stderr: "" };
          },
        }),
      ),
    );
    expect(result.state).toBe("running");
    expect(calls[0]).toEqual(["/Query", "/TN", "AutoHarnessHostDaemon", "/FO", "LIST", "/V"]);
  });

  it("maps missing, stopped, and unknown task responses", () => {
    expect(
      statusWin32(
        resolveHostService(
          baseOpts({
            platform: "win32",
            fs: seededFs(),
            run: () => ({
              status: 1,
              stdout: "",
              stderr: "ERROR: The system cannot find the file",
            }),
          }),
        ),
      ).state,
    ).toBe("missing");
    expect(
      statusWin32(
        resolveHostService(
          baseOpts({
            platform: "win32",
            fs: seededFs(),
            run: () => ({ status: 0, stdout: "Status: Ready\n", stderr: "" }),
          }),
        ),
      ).state,
    ).toBe("stopped");
    expect(
      statusWin32(
        resolveHostService(
          baseOpts({
            platform: "win32",
            fs: seededFs(),
            run: () => ({ status: 0, stdout: "TaskName: AutoHarnessHostDaemon\n", stderr: "" }),
          }),
        ),
      ).state,
    ).toBe("unknown");
    const options: Array<Record<string, unknown> | undefined> = [];
    expect(
      statusWin32(
        resolveHostService(
          baseOpts({
            platform: "win32",
            fs: seededFs(),
            timeoutMs: 200,
            run: (_command, _args, runOptions) => {
              options.push(runOptions);
              return { status: 1, stdout: "", stderr: "access denied" };
            },
          }),
        ),
      ).state,
    ).toBe("unknown");
    expect(options).toEqual([{ timeoutMs: 200 }]);
  });
});
