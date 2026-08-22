import { describe, expect, it } from "vitest";

import { installHostService, uninstallHostService } from "./host-service.ts";
import { resolveHostService } from "./host-service-io.ts";
import { statusDarwin } from "./host-service-darwin.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";

describe("install-service darwin", () => {
  it("writes LaunchAgent + env and kickstarts", () => {
    const fs = seededFs();
    const spawn = recorder();
    expect(
      installHostService(
        baseOpts({
          platform: "darwin",
          fs,
          run: spawn.run,
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
    expect(fs.modes.get("/Users/op/Library/Application Support/auto-harness/host-daemon.env")).toBe(
      0o600,
    );
    expect(spawn.calls.map((c) => c.args[0])).toEqual(["bootout", "bootstrap", "kickstart"]);
  });

  it("falls back to launchctl load and keeps an existing env file", () => {
    const envPath = "/Users/op/Library/Application Support/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://example.cloudfront.net\nHARNESS_API_KEY=secret\n",
    });
    const spawn = recorder({
      "launchctl bootstrap gui/501 /Users/op/Library/LaunchAgents/com.auto-harness.host-daemon.plist":
        { status: 1, stdout: "", stderr: "no bootstrap" },
    });
    const logs: string[] = [];
    expect(
      installHostService(
        baseOpts({ platform: "darwin", fs, run: spawn.run, log: (m) => logs.push(m) }),
      ),
    ).toBe(0);
    expect(fs.files.get(envPath)).toContain("HARNESS_API_KEY=secret");
    expect(logs.join("\n")).toMatch(/Keeping existing env file/);
    expect(spawn.calls.at(-1)?.args[0]).toBe("load");
  });

  it("reports bootstrap/load and kickstart failures", () => {
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
    const kickErrors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          error: (m) => kickErrors.push(m),
          run: (_command, args) =>
            args[0] === "kickstart"
              ? { status: 1, stdout: "", stderr: "kick" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(kickErrors.join("\n")).toMatch(/kickstart/);
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
});
