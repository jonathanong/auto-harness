/* eslint-disable max-lines -- launchd installation, execution settings, status, and restart scenarios share fixtures. */
import { describe, expect, it } from "vitest";

import { installHostService, restartHostService, uninstallHostService } from "./host-service.ts";
import { resolveHostService } from "./host-service-io.ts";
import { statusDarwin } from "./host-service-darwin.ts";
import { baseOpts, seededFs } from "./host-service-test-helpers.ts";

describe("install-service darwin", () => {
  it("writes a stable current-selecting launcher and force-kickstarts it", () => {
    const fs = seededFs();
    const calls: string[][] = [];
    let prints = 0;
    const run = (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] !== "print") return { status: 0, stdout: "", stderr: "" };
      prints += 1;
      return prints === 1
        ? { status: 0, stdout: "state = waiting\n", stderr: "" }
        : { status: 0, stdout: "state = running\npid = 42\n", stderr: "" };
    };
    expect(
      installHostService(
        baseOpts({
          platform: "darwin",
          fs,
          run,
          env: {
            HARNESS_HOST_ID: "host-1",
            HARNESS_API_URL: "https://example.cloudfront.net",
            HARNESS_API_KEY: "secret",
            PATH: "/opt/homebrew/bin:/usr/bin",
          },
        }),
      ),
    ).toBe(0);
    const plist = [...fs.files.entries()].find(([path]) => path.endsWith(".plist"))?.[1];
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<string>/Users/op</string>");
    expect(plist).toContain("/opt/homebrew/bin:/usr/bin");
    expect(plist).toContain("HARNESS_ENV_FILE");
    expect(plist).not.toContain("secret");
    expect(plist).toContain("run-host-daemon.sh");
    expect(plist).not.toContain("/checkout/services/host-daemon/bin");
    expect(
      fs.files.get("/Users/op/Library/Application Support/auto-harness/run-host-daemon.sh"),
    ).toContain("/Users/op/Library/Application Support/auto-harness/updates/current");
    expect(fs.modes.get("/Users/op/Library/Application Support/auto-harness/host-daemon.env")).toBe(
      0o600,
    );
    expect(calls.map((args) => args[0])).toEqual([
      "bootout",
      "bootstrap",
      "print",
      "kickstart",
      "print",
    ]);
    expect(calls.find((args) => args[0] === "kickstart")).toEqual([
      "kickstart",
      "-k",
      "gui/501/com.auto-harness.host-daemon",
    ]);
  });

  it("falls back to launchctl load and keeps an existing env file", () => {
    const envPath = "/Users/op/Library/Application Support/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\n",
    });
    const calls: string[][] = [];
    let prints = 0;
    const run = (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "bootstrap") return { status: 1, stdout: "", stderr: "no bootstrap" };
      if (args[0] !== "print") return { status: 0, stdout: "", stderr: "" };
      prints += 1;
      return prints === 1
        ? { status: 0, stdout: "state = waiting\n", stderr: "" }
        : { status: 0, stdout: "state = running\npid = 43\n", stderr: "" };
    };
    const logs: string[] = [];
    expect(
      installHostService(baseOpts({ platform: "darwin", fs, run, log: (m) => logs.push(m) })),
    ).toBe(0);
    expect(fs.files.get(envPath)).toContain("HARNESS_API_KEY=secret");
    expect(logs.join("\n")).toMatch(/Keeping existing env file/);
    expect(calls.map((args) => args[0])).toEqual([
      "bootout",
      "bootstrap",
      "load",
      "print",
      "kickstart",
      "print",
    ]);
  });

  it("merges exported execution settings into an existing env", () => {
    const envPath = "/Users/op/Library/Application Support/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\nOTHER=keep\n",
    });
    expect(
      installHostService(
        baseOpts({
          platform: "darwin",
          fs,
          env: {
            HARNESS_EXECUTION_PROFILES: "/Users/op/profiles.json",
            HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "4",
          },
          run: () => ({ status: 0, stdout: "state = running\npid = 44\n", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(envPath)).toContain("HARNESS_EXECUTION_PROFILES=/Users/op/profiles.json");
    expect(fs.files.get(envPath)).toContain("HARNESS_MAX_CONCURRENT_ASSIGNMENTS=4");
    expect(fs.files.get(envPath)).toContain("HARNESS_API_KEY=secret");
    expect(fs.files.get(envPath)).toContain("OTHER=keep");
  });

  it("reports bootstrap/load failures", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          error: (m) => errors.push(m),
          run: () => ({ status: 1, stdout: "", stderr: "launchctl down" }),
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/bootstrap\/load/);
  });

  it("unloads and removes the plist only", () => {
    const plist = "/Users/op/Library/LaunchAgents/com.auto-harness.host-daemon.plist";
    const envPath = "/Users/op/Library/Application Support/auto-harness/host-daemon.env";
    const fs = seededFs({ [plist]: "<plist />", [envPath]: "KEEP=1\n" });
    expect(
      uninstallHostService(
        baseOpts({
          platform: "darwin",
          fs,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
    expect(fs.files.has(plist)).toBe(false);
    expect(fs.files.get(envPath)).toBe("KEEP=1\n");
    expect(
      uninstallHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(0);
  });
});

describe("status darwin", () => {
  it("maps launchctl state and uses the per-user service label", () => {
    const calls: string[][] = [];
    const result = statusDarwin(
      resolveHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          uid: 501,
          run: (_command, args) => {
            calls.push(args);
            return { status: 0, stdout: "state = running\n", stderr: "" };
          },
        }),
      ),
    );
    expect(result.state).toBe("running");
    expect(calls[0]).toEqual(["print", "gui/501/com.auto-harness.host-daemon"]);
  });

  it("maps not-found and stopped launch agents", () => {
    expect(
      statusDarwin(
        resolveHostService(
          baseOpts({
            platform: "darwin",
            fs: seededFs(),
            run: () => ({ status: 1, stdout: "", stderr: "Could not find service" }),
          }),
        ),
      ).state,
    ).toBe("missing");
    expect(
      statusDarwin(
        resolveHostService(
          baseOpts({
            platform: "darwin",
            fs: seededFs(),
            run: () => ({ status: 0, stdout: "state = waiting\n", stderr: "" }),
          }),
        ),
      ).state,
    ).toBe("stopped");
  });

  it("maps explicit timeouts, failed commands, stopped, and unknown states", () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    for (const [status, stdout, expected] of [
      [1, "", "failed"],
      [0, "state = stopped\n", "stopped"],
      [0, "state = mystery\n", "unknown"],
    ] as const) {
      const result = statusDarwin(
        resolveHostService(
          baseOpts({
            platform: "darwin",
            fs: seededFs(),
            timeoutMs: 123,
            run: (_command, _args, options) => {
              seen.push(options);
              return { status, stdout, stderr: status ? "permission denied" : "" };
            },
          }),
        ),
      );
      expect(result.state).toBe(expected);
    }
    expect(seen).toEqual([{ timeoutMs: 123 }, { timeoutMs: 123 }, { timeoutMs: 123 }]);
  });
});

describe("restart darwin", () => {
  it("uses kickstart -k and requires a replacement running pid", () => {
    let prints = 0;
    const calls: string[][] = [];
    expect(
      restartHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          run: (_command, args) => {
            calls.push(args);
            if (args[0] !== "print") return { status: 0, stdout: "", stderr: "" };
            prints += 1;
            return prints === 1
              ? { status: 0, stdout: "state = running\npid = 101\n", stderr: "" }
              : { status: 0, stdout: "state = running\npid = 102\n", stderr: "" };
          },
        }),
      ),
    ).toBe(0);
    expect(calls).toEqual([
      ["print", "gui/501/com.auto-harness.host-daemon"],
      ["kickstart", "-k", "gui/501/com.auto-harness.host-daemon"],
      ["print", "gui/501/com.auto-harness.host-daemon"],
    ]);
  });

  it("fails when launchd leaves the prior pid or returns in-progress", () => {
    const errors: string[] = [];
    for (const run of [
      (_command: string, args: string[]) =>
        args[0] === "print"
          ? { status: 0, stdout: "state = running\npid = 101\n", stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
      (_command: string, args: string[]) =>
        args[0] === "print"
          ? { status: 0, stdout: "state = running\npid = 101\n", stderr: "" }
          : { status: 37, stdout: "", stderr: "already in progress" },
    ]) {
      expect(
        restartHostService(
          baseOpts({ platform: "darwin", fs: seededFs(), run, error: (m) => errors.push(m) }),
        ),
      ).toBe(1);
    }
    expect(errors.join("\n")).toMatch(/verification|kickstart -k/);
  });
});
