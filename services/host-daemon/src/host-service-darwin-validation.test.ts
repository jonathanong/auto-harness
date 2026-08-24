import { describe, expect, it } from "vitest";

import { installHostService } from "./host-service.ts";
import { baseOpts, recorder, seededFs } from "./host-service-test-helpers.ts";

describe("install-service darwin validation and updates", () => {
  it("refuses an invalid existing env before writing or restarting", () => {
    const fs = seededFs({
      "/Users/op/Library/Application Support/auto-harness/host-daemon.env":
        "HARNESS_HOST_ID=host-1\nHARNESS_API_KEY=secret\n",
    });
    const before = new Map(fs.files);
    const logs: string[] = [];
    const calls: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "darwin",
          fs,
          log: (m) => logs.push(m),
          error: (m) => logs.push(m),
          run: (command) => {
            calls.push(command);
            return { status: 0, stdout: "", stderr: "" };
          },
        }),
      ),
    ).toBe(1);
    expect(logs.join("\n")).toMatch(/HARNESS_API_URL/);
    expect(logs.join("\n")).not.toContain("secret");
    expect(calls).toEqual([]);
    expect(fs.files).toEqual(before);
  });

  it("updates only the persisted API URL while retaining the bound key", () => {
    const envPath = "/Users/op/Library/Application Support/auto-harness/host-daemon.env";
    const fs = seededFs({
      [envPath]:
        "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://old.example.com\nHARNESS_API_KEY=secret\nOTHER=value\n",
    });
    const spawn = recorder();
    expect(
      installHostService(
        baseOpts({ platform: "darwin", fs, run: spawn.run, apiUrl: "https://new.example.com" }),
      ),
    ).toBe(0);
    expect(fs.files.get(envPath)).toBe(
      "HARNESS_HOST_ID=host-1\nHARNESS_API_URL=https://new.example.com\nHARNESS_API_KEY=secret\nOTHER=value\n",
    );
    expect(spawn.calls.map((call) => call.args[0])).toEqual([
      "bootout",
      "bootstrap",
      "print",
      "kickstart",
      "print",
    ]);
  });

  it("fails when launchctl does not register the service", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          error: (message) => errors.push(message),
          run: (_command, args) =>
            args[0] === "print"
              ? { status: 1, stdout: "", stderr: "missing" }
              : { status: 0, stdout: "", stderr: "" },
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/verification/);
  });
});
