import { describe, expect, it } from "vitest";

import { installHostService } from "./host-service.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";
import { LINUX_ENV_DEST } from "./host-service-templates.ts";

describe("install-service API URL updates", () => {
  it("updates a Linux persisted URL without replacing its key", () => {
    const fs = seededFs({
      [LINUX_ENV_DEST]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://old.example.com\nHARNESS_API_KEY=secret\n",
    });
    const spawn = recorder();
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs,
          run: spawn.run,
          apiUrl: "https://new.example.com",
        }),
      ),
    ).toBe(0);
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("HARNESS_API_URL=https://new.example.com");
    expect(fs.files.get(LINUX_ENV_DEST)).toContain("HARNESS_API_KEY=secret");
    expect(spawn.calls.map((call) => call.args.join(" "))).toEqual([
      "-d -o root -g root -m 0755 /opt/auto-harness",
      "-d -o harness -g harness -m 0700 /opt/auto-harness/incoming",
      "-d -o harness -g harness -m 0700 /opt/auto-harness/staging",
      "-d -o root -g root -m 0755 /usr/local/lib/auto-harness",
      "-d -o root -g root -m 0755 /opt/auto-harness/releases",
      "daemon-reload",
      "enable auto-harness-host-daemon.service",
      "restart auto-harness-host-daemon.service",
    ]);
  });

  it("updates a Windows persisted URL without replacing its key", () => {
    const envPath = "/Users/op/AppData/Roaming/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://old.example.com\nHARNESS_API_KEY=secret\n",
    });
    const spawn = recorder({
      "schtasks /End /TN AutoHarnessHostDaemon": {
        status: 1,
        stdout: "",
        stderr: "ERROR: The task is not running",
      },
    });
    expect(
      installHostService(
        baseOpts({ platform: "win32", fs, run: spawn.run, apiUrl: "https://new.example.com" }),
      ),
    ).toBe(0);
    expect(fs.files.get(envPath)).toContain("HARNESS_API_URL=https://new.example.com");
    expect(fs.files.get(envPath)).toContain("HARNESS_API_KEY=secret");
  });
});
