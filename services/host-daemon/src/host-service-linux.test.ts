import { describe, expect, it } from "vitest";

import { installHostService, uninstallHostService } from "./host-service.ts";
import { baseOpts, recorder, seededFs, unitTemplate } from "./host-service-test-helpers.ts";
import {
  LINUX_ENABLE_COMMAND,
  LINUX_ENV_DEST,
  LINUX_OPT_CURRENT,
  LINUX_UNIT_DEST,
} from "./host-service-templates.ts";

describe("install-service linux", () => {
  it("stages files and prints sudo enable when not root", () => {
    const fs = seededFs();
    const logs: string[] = [];
    const code = installHostService(
      baseOpts({
        platform: "linux",
        uid: 501,
        fs,
        log: (m) => logs.push(m),
        run: () => ({ status: 0, stdout: "", stderr: "" }),
      }),
    );
    expect(code).toBe(0);
    expect(
      fs.files.get("/tmp/auto-harness-host-service/auto-harness-host-daemon.service"),
    ).toContain("WorkingDirectory=/checkout");
    expect(fs.modes.get("/tmp/auto-harness-host-service/host-daemon.env")).toBe(0o600);
    expect(logs.join("\n")).toContain(`sudo ${LINUX_ENABLE_COMMAND}`);
    const existing = seededFs({ [LINUX_ENV_DEST]: "KEEP=1\n" });
    const existingLogs: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 501,
          fs: existing,
          log: (m) => existingLogs.push(m),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(existing.files.has("/tmp/auto-harness-host-service/host-daemon.env")).toBe(false);
    expect(existingLogs.join("\n")).not.toMatch(/install -m 0600/);
  });

  it("keeps /opt working directory and existing env as root", () => {
    const fs = seededFs({
      [LINUX_OPT_CURRENT]: "",
      [LINUX_ENV_DEST]: "HARNESS_HOST_ID=existing\n",
    });
    const spawn = recorder();
    const logs: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs,
          run: spawn.run,
          log: (m) => logs.push(m),
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(LINUX_UNIT_DEST)).toContain(`WorkingDirectory=${LINUX_OPT_CURRENT}`);
    expect(fs.files.get(LINUX_ENV_DEST)).toBe("HARNESS_HOST_ID=existing\n");
    expect(logs.join("\n")).toMatch(/Keeping existing env file/);
    expect(spawn.calls.map((c) => [c.command, ...c.args].join(" "))).toEqual([
      "systemctl daemon-reload",
      "systemctl enable --now auto-harness-host-daemon.service",
    ]);
  });

  it("writes env as root and reports systemctl failures", () => {
    const fs = seededFs();
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs,
          run: () => ({ status: 1, stdout: "", stderr: "reload failed" }),
        }),
      ),
    ).toBe(1);
    expect(fs.modes.get(LINUX_ENV_DEST)).toBe(0o600);
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          error: (m) => errors.push(m),
          run: (_command, args) =>
            args[0] === "enable"
              ? { status: 1, stdout: "", stderr: "enable failed" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/enable failed/);
  });

  it("prints sudo uninstall when not root and disables when root", () => {
    const logs: string[] = [];
    expect(
      uninstallHostService(
        baseOpts({
          platform: "linux",
          uid: 501,
          fs: seededFs(),
          log: (m) => logs.push(m),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(logs.join("\n")).toContain("sudo systemctl disable --now");
    const fs = seededFs({ [LINUX_UNIT_DEST]: unitTemplate });
    const spawn = recorder({
      "systemctl daemon-reload": { status: 1, stdout: "", stderr: "reload" },
    });
    expect(uninstallHostService(baseOpts({ platform: "linux", uid: 0, fs, run: spawn.run }))).toBe(
      1,
    );
    expect(fs.files.has(LINUX_UNIT_DEST)).toBe(false);
  });

  it("root uninstall succeeds after disable and reload", () => {
    expect(
      uninstallHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
  });
});
