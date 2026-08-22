import { writeFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { type ProcessRunner, SpawnProcessRunner } from "./executor.ts";
import { runSetupScript } from "./setup-script.ts";

describe("runSetupScript", () => {
  it("invokes a shell with the script and private environment capture", async () => {
    let seen: string[] | undefined;
    const runner: ProcessRunner = {
      async run(opts) {
        seen = opts.argv;
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    await runSetupScript(runner, "true", "/tmp", 1000, () => undefined);
    expect(seen?.[1]).toBe("-c");
    expect(seen?.[2]).toContain("true");
    expect(seen).toContain(process.execPath);
  });

  it("captures exported setup values without forwarding the HARNESS namespace", async () => {
    const result = await runSetupScript(
      new SpawnProcessRunner(),
      "export AGENT_BLACKBOARD_URL=https://blackboard.test; export HARNESS_API_KEY=not-allowed",
      process.cwd(),
      1_000,
      () => undefined,
      undefined,
      { PATH: process.env.PATH, SHELL: "/bin/sh" },
    );
    expect(result.environment?.AGENT_BLACKBOARD_URL).toBe("https://blackboard.test");
    expect(result.environment?.HARNESS_API_KEY).toBeUndefined();
  });

  it.each([
    [undefined, "/bin/sh"],
    ["zsh", "/bin/sh"],
    ["/not-installed/zsh", "/bin/sh"],
    [process.execPath, "/bin/sh"],
    ["/bin/sh", "/bin/sh"],
  ])("uses a safe shell for SHELL=%s", async (shell, expected) => {
    let command: string | undefined;
    await runSetupScript(
      {
        async run(options) {
          command = options.argv[0];
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      "true",
      "/tmp",
      1_000,
      () => undefined,
      undefined,
      shell === undefined ? {} : { SHELL: shell },
    );
    expect(command).toBe(expected);
  });

  it("filters reserved and non-string values from a supplied snapshot", async () => {
    const result = await runSetupScript(
      snapshotRunner({ KEEP: "yes", HARNESS_SECRET: "no", NUMBER: 1 }),
      "true",
      "/tmp",
      1_000,
      () => undefined,
    );
    expect(result.environment).toEqual({ KEEP: "yes" });
  });

  it.each([null, 1, []])("rejects an invalid environment snapshot: %j", async (snapshot) => {
    await expect(
      runSetupScript(snapshotRunner(snapshot), "true", "/tmp", 1_000, () => undefined),
    ).rejects.toThrow("invalid environment snapshot");
  });

  it("does not hide a malformed environment snapshot", async () => {
    await expect(
      runSetupScript(snapshotRunner("{invalid-json", true), "true", "/tmp", 1_000, () => undefined),
    ).rejects.toThrow(SyntaxError);
  });

  it.each([
    { exitCode: 1, timedOut: false, signal: null },
    { exitCode: null, timedOut: true, signal: "SIGTERM" as const },
    { exitCode: null, timedOut: false, cancelled: true, signal: "SIGTERM" as const },
  ])("returns an unsuccessful setup result without reading a snapshot", async (outcome) => {
    await expect(
      runSetupScript(
        {
          async run() {
            return outcome;
          },
        },
        "false",
        "/tmp",
        1_000,
        () => undefined,
      ),
    ).resolves.toEqual(outcome);
  });
});

function snapshotRunner(snapshot: unknown, raw = false): ProcessRunner {
  return {
    async run(options) {
      await writeFile(options.argv[6]!, raw ? String(snapshot) : JSON.stringify(snapshot));
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
}
