/* eslint-disable max-lines -- platform install and status mappings are tested together. */
import { describe, expect, it } from "vitest";

import { installHostService, uninstallHostService } from "./host-service.ts";
import { resolveHostService } from "./host-service-io.ts";
import { statusLinux } from "./host-service-linux.ts";
import { baseOpts, recorder, seededFs, unitTemplate } from "./host-service-test-helpers.ts";
import {
  LINUX_ACTIVATION_HELPER_DEST,
  LINUX_ENABLE_NOW_COMMAND,
  LINUX_ENV_DEST,
  LINUX_LAUNCHER_DEST,
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
    expect(fs.files.get(`${stagedDir}/run-host-daemon.sh`)).toContain("cd '/checkout'");
    expect(fs.modes.get(`${stagedDir}/host-daemon.env`)).toBe(0o600);
    expect(fs.flags.get(`${stagedDir}/host-daemon.env`)).toBe("wx");
    expect(logs.join("\n")).toContain(`ephemeral directory ${stagedDir}`);
    expect(logs.join("\n")).toContain(`sudo ${LINUX_RELOAD_COMMAND}`);
    expect(logs.join("\n")).toContain(`sudo ${LINUX_ENABLE_NOW_COMMAND}`);
    expect(logs.join("\n")).toContain(
      "sudo install -d -o root -g root -m 0755 '/opt/auto-harness'",
    );
    expect(logs.join("\n")).toContain(
      "sudo install -d -o harness -g harness -m 0700 '/opt/auto-harness/incoming'",
    );
    expect(logs.join("\n")).toContain(
      "sudo install -d -o harness -g harness -m 0700 '/opt/auto-harness/staging'",
    );
    expect(logs.join("\n")).toContain(
      "sudo install -d -o root -g root -m 0755 '/usr/local/lib/auto-harness'",
    );
  });

  it("shell-quotes every staged Linux installation path", () => {
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
            HARNESS_UPDATE_INSTALL_DIR: "/srv/auto harness's updates",
          },
          log: (message) => logs.push(message),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    const instructions = logs.join("\n");
    expect(instructions).toContain("'/srv/auto harness'\"'\"'s updates'");
    expect(instructions).toContain("'/srv/auto harness'\"'\"'s updates/incoming'");
    expect(instructions).toContain(
      "'/tmp/auto-harness-host-service-XXXXXX/auto-harness-host-daemon.service' '/etc/systemd/system/auto-harness-host-daemon.service'",
    );
    expect(instructions).not.toContain("-m 0755 /srv/auto harness");
  });

  it("keeps /opt working directory and existing env as root", () => {
    const fs = seededFs({
      [LINUX_OPT_CURRENT]: "",
      [LINUX_ENV_DEST]:
        "HARNESS_HOST_ID=existing\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\n",
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
    expect(fs.files.get(LINUX_UNIT_DEST)).toContain(`ExecStart=/bin/sh "${LINUX_LAUNCHER_DEST}"`);
    expect(fs.files.get(LINUX_LAUNCHER_DEST)).toContain(`cd '${LINUX_OPT_CURRENT}'`);
    expect(fs.files.get(LINUX_ACTIVATION_HELPER_DEST)).toContain("activation request");
    const unit = fs.files.get(LINUX_UNIT_DEST)!;
    expect(unit).toContain(
      "ExecStartPre=+/usr/bin/env node /usr/local/lib/auto-harness/promote-host-daemon-update.mjs",
    );
    expect(unit).toContain("--mark-boot-attempt");
    expect(unit.indexOf("--mark-boot-attempt")).toBeGreaterThan(
      unit.indexOf("promote-host-daemon-update.mjs\n"),
    );
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("HARNESS_API_KEY=secret");
    expect(logs.join("\n")).toMatch(/Keeping existing env file/);
    expect(spawn.calls.map((c) => [c.command, ...c.args].join(" "))).toEqual([
      "install -d -o root -g root -m 0755 /opt/auto-harness",
      "install -d -o harness -g harness -m 0700 /opt/auto-harness/incoming",
      "install -d -o harness -g harness -m 0700 /opt/auto-harness/staging",
      "install -d -o root -g root -m 0755 /usr/local/lib/auto-harness",
      "install -d -o root -g root -m 0755 /opt/auto-harness/releases",
      "chown -R root:root /opt/auto-harness/current",
      "chmod -R go-w /opt/auto-harness/current",
      "systemctl daemon-reload",
      "systemctl enable auto-harness-host-daemon.service",
      "systemctl restart auto-harness-host-daemon.service",
    ]);
  });

  it("persists a custom update root for the generated launcher and unit", () => {
    const updateRoot = "/srv/auto-harness";
    const fs = seededFs({
      [`${updateRoot}/current`]: "",
      [LINUX_ENV_DEST]:
        "HARNESS_HOST_ID=existing\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\n",
    });
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs,
          env: { HARNESS_UPDATE_INSTALL_DIR: updateRoot },
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(LINUX_UNIT_DEST)).toContain(`WorkingDirectory=${updateRoot}/current`);
    expect(fs.files.get(LINUX_UNIT_DEST)).toContain(`ExecStart=/bin/sh "${LINUX_LAUNCHER_DEST}"`);
    expect(fs.files.get(LINUX_LAUNCHER_DEST)).toContain(`cd '${updateRoot}/current'`);
    expect(fs.files.get(LINUX_ENV_DEST)).toContain(`HARNESS_UPDATE_INSTALL_DIR=${updateRoot}`);
    // Reinstalling migrates the conventional mutable checkout before the
    // root-owned launcher can execute it.
    expect(fs.files.get(LINUX_LAUNCHER_DEST)).toContain("exec");
  });

  it("refuses to enable a migrated service when its current release cannot be locked", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs({ [LINUX_OPT_CURRENT]: "" }),
          error: (message) => errors.push(message),
          run: (command) =>
            command === "chown"
              ? { status: 1, stdout: "", stderr: "permission denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors).toEqual(["lock existing current release ownership failed: permission denied"]);
  });

  it("locks a legacy current-pointer target before enabling the root-owned wrapper", () => {
    const spawn = recorder();
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs({ [LINUX_OPT_CURRENT]: "", "/opt/auto-harness/versions": "" }),
          run: spawn.run,
        }),
      ),
    ).toBe(0);
    expect(spawn.calls).toContainEqual({
      command: "chown",
      args: ["-R", "root:root", "/opt/auto-harness/versions"],
    });
    expect(spawn.calls).toContainEqual({
      command: "chmod",
      args: ["-R", "go-w", "/opt/auto-harness/versions"],
    });
  });

  it("provisions private incoming and staging directories for the unprivileged daemon", () => {
    const updateRoot = "/srv/auto-harness";
    const spawn = recorder();
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          env: {
            HARNESS_HOST_ID: "host-1",
            HARNESS_API_URL: "https://example.cloudfront.net",
            HARNESS_API_KEY: "secret",
            HARNESS_UPDATE_INSTALL_DIR: updateRoot,
          },
          run: spawn.run,
        }),
      ),
    ).toBe(0);
    expect(spawn.calls.slice(0, 4)).toEqual([
      {
        command: "install",
        args: ["-d", "-o", "root", "-g", "root", "-m", "0755", updateRoot],
      },
      {
        command: "install",
        args: ["-d", "-o", "harness", "-g", "harness", "-m", "0700", `${updateRoot}/incoming`],
      },
      {
        command: "install",
        args: ["-d", "-o", "harness", "-g", "harness", "-m", "0700", `${updateRoot}/staging`],
      },
      {
        command: "install",
        args: ["-d", "-o", "root", "-g", "root", "-m", "0755", "/usr/local/lib/auto-harness"],
      },
    ]);
  });

  it("does not install a service when the update root cannot be made root-owned", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          error: (message) => errors.push(message),
          run: (command) =>
            command === "install"
              ? { status: 1, stdout: "", stderr: "permission denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors).toEqual(["install writable update root failed: permission denied"]);
  });

  it("does not install a service when the daemon incoming directory cannot be made writable", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          error: (message) => errors.push(message),
          run: (_command, args) =>
            args.at(-1) === "/opt/auto-harness/incoming"
              ? { status: 1, stdout: "", stderr: "permission denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors).toEqual([
      "install writable update incoming directory failed: permission denied",
    ]);
  });

  it("does not install a service when deployment staging cannot be made writable", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          error: (message) => errors.push(message),
          run: (_command, args) =>
            args.at(-1) === "/opt/auto-harness/staging"
              ? { status: 1, stdout: "", stderr: "permission denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors).toEqual([
      "install writable deployment staging directory failed: permission denied",
    ]);
  });

  it("does not install a service when the root-owned launcher directory cannot be provisioned", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          error: (message) => errors.push(message),
          run: (_command, args) =>
            args.at(-1) === "/usr/local/lib/auto-harness"
              ? { status: 1, stdout: "", stderr: "permission denied" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors).toEqual(["install root-owned launcher directory failed: permission denied"]);
  });

  it("merges exported execution settings into an existing env", () => {
    const fs = seededFs({
      [LINUX_ENV_DEST]:
        "HARNESS_HOST_ID=existing\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\nOTHER=keep\n",
    });
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs,
          env: {
            HARNESS_EXECUTION_PROFILES: "/etc/auto-harness/profiles.json",
            HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "3",
          },
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(LINUX_ENV_DEST)).toContain(
      "HARNESS_EXECUTION_PROFILES=/etc/auto-harness/profiles.json",
    );
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("HARNESS_MAX_CONCURRENT_ASSIGNMENTS=3");
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("HARNESS_API_KEY=secret");
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("OTHER=keep");
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
          run: (command, args) =>
            command === "systemctl" && args[0] === "daemon-reload"
              ? { status: 1, stdout: "", stderr: "reload failed" }
              : { status: 0, stdout: "", stderr: "" },
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

  it("persists execution profile settings from the install environment", () => {
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
            HARNESS_EXECUTION_PROFILES: "/etc/auto-harness/profiles.json",
            HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "3",
          },
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(LINUX_ENV_DEST)).toContain(
      "HARNESS_EXECUTION_PROFILES=/etc/auto-harness/profiles.json",
    );
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("HARNESS_MAX_CONCURRENT_ASSIGNMENTS=3");
  });

  it("reports split enable and restart failures for an existing root environment update", () => {
    const existing = {
      [LINUX_ENV_DEST]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://old.example\nHARNESS_API_KEY=secret\n",
    };
    for (const failed of ["enable", "restart"]) {
      expect(
        installHostService(
          baseOpts({
            platform: "linux",
            uid: 0,
            apiUrl: "https://new.example",
            fs: seededFs(existing),
            run: (_command, args) => ({
              status: args[0] === failed ? 1 : 0,
              stdout: "",
              stderr: `${failed} failed`,
            }),
          }),
        ),
      ).toBe(1);
    }
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
    let timeoutMs: number | undefined;
    const missing = statusLinux(
      resolveHostService(
        baseOpts({
          platform: "linux",
          fs: seededFs(),
          timeoutMs: 17,
          run: (_command, args, opts) => {
            calls.push(args);
            timeoutMs = opts?.timeoutMs;
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
    expect(timeoutMs).toBe(17);
  });

  it("maps command, Result-only, and unrecognized status outcomes", () => {
    for (const [status, stdout, expected] of [
      [1, "LoadState=loaded\n", "unknown"],
      [0, "LoadState=loaded\nActiveState=activating\nResult=failed\n", "failed"],
      [0, "LoadState=loaded\nActiveState=activating\nResult=success\n", "unknown"],
    ] as const) {
      expect(
        statusLinux(
          resolveHostService(
            baseOpts({
              platform: "linux",
              fs: seededFs(),
              run: () => ({ status, stdout, stderr: "" }),
            }),
          ),
        ).state,
      ).toBe(expected);
    }
  });
});
