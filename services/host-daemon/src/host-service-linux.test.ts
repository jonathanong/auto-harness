/* eslint-disable max-lines -- platform install and status mappings are tested together. */
import { describe, expect, it } from "vitest";

import { installHostService, uninstallHostService } from "./host-service.ts";
import { resolveHostService } from "./host-service-io.ts";
import { statusLinux } from "./host-service-linux.ts";
import { baseOpts, recorder, seededFs, unitTemplate } from "./host-service-test-helpers.ts";
import {
  LINUX_ENABLE_NOW_COMMAND,
  LINUX_ENV_DEST,
  LINUX_OPT_CURRENT,
  LINUX_RELOAD_COMMAND,
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
    const stagedDir = "/tmp/auto-harness-host-service-XXXXXX";
    expect(fs.files.get(`${stagedDir}/auto-harness-host-daemon.service`)).toContain(
      "WorkingDirectory=/checkout",
    );
    expect(fs.modes.get(`${stagedDir}/host-daemon.env`)).toBe(0o600);
    expect(fs.flags.get(`${stagedDir}/host-daemon.env`)).toBe("wx");
    expect(logs.join("\n")).toContain(`ephemeral directory ${stagedDir}`);
    expect(logs.join("\n")).toContain(`sudo ${LINUX_RELOAD_COMMAND}`);
    expect(logs.join("\n")).toContain(`sudo ${LINUX_ENABLE_NOW_COMMAND}`);
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
    expect(existing.files.has(`${stagedDir}/host-daemon.env`)).toBe(false);
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
          env: {
            HARNESS_HOST_ID: "host-1",
            HARNESS_API_URL: "https://example.cloudfront.net",
            HARNESS_API_KEY: "secret",
            PATH: "/opt/homebrew/bin:/usr/bin",
          },
          run: () => ({ status: 1, stdout: "", stderr: "reload failed" }),
        }),
      ),
    ).toBe(1);
    expect(fs.modes.get(LINUX_ENV_DEST)).toBe(0o600);
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(fs.files.get(LINUX_ENV_DEST)).not.toContain("PATH=/opt/homebrew");
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

  it("refuses a new linux env file with local/placeholder identity", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          env: {
            HARNESS_HOST_ID: "local-1",
            HARNESS_API_URL: "http://127.0.0.1:7420",
            PATH: "/opt/homebrew/bin",
          },
          error: (m) => errors.push(m),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/HARNESS_HOST_ID/);
    expect(errors.join("\n")).toMatch(/HARNESS_API_KEY/);
  });

  it("stages under XDG_RUNTIME_DIR when set", () => {
    const fs = seededFs();
    const logs: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 501,
          fs,
          env: {
            HARNESS_HOST_ID: "host-1",
            HARNESS_API_URL: "https://example.cloudfront.net",
            HARNESS_API_KEY: "secret",
            XDG_RUNTIME_DIR: "/run/user/501",
          },
          log: (m) => logs.push(m),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(logs.join("\n")).toContain("/run/user/501/auto-harness-host-service-XXXXXX");
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

describe("status linux", () => {
  it.each([
    ["active", "running", "success", "running"],
    ["inactive", "dead", "success", "stopped"],
    ["failed", "failed", "success", "failed"],
  ] as const)("maps systemd %s/%s to %s", (active, sub, _label, state) => {
    const result = statusLinux(
      resolveHostService(
        baseOpts({
          platform: "linux",
          fs: seededFs(),
          run: () => ({
            status: 0,
            stdout: `LoadState=loaded\nActiveState=${active}\nSubState=${sub}\nResult=success\n`,
            stderr: "",
          }),
        }),
      ),
    );
    expect(result.state).toBe(state);
  });

  it("distinguishes missing and command failure with a fixed bounded command", () => {
    const calls: string[][] = [];
    const missing = statusLinux(
      resolveHostService(
        baseOpts({
          platform: "linux",
          fs: seededFs(),
          run: (_command, args) => {
            calls.push(args);
            return { status: 0, stdout: "LoadState=not-found\n", stderr: "" };
          },
        }),
      ),
    );
    expect(missing).toEqual({ state: "missing", reason: "systemd unit is not installed" });
    expect(calls[0]).toEqual([
      "show",
      "--no-pager",
      "--property=LoadState,ActiveState,SubState,Result",
      "auto-harness-host-daemon.service",
    ]);
  });
});
