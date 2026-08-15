import { describe, expect, it } from "vitest";

import { baseAssign, setup } from "./session-runner-test-helpers.ts";

describe("SessionRunner lifecycle transcript", () => {
  it("emits successful setup and process markers without command arguments", async () => {
    const { sessionRunner } = setup({
      async run(opts) {
        if (opts.argv[0] === "/bin/sh" && opts.argv[1] === "-c") {
          opts.onChunk({ stream: "stdout", data: "setup output\n" });
        } else if (opts.argv[0] === "codex") {
          opts.onChunk({ stream: "stdout", data: "command output\n" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      },
    });
    const result = await sessionRunner.run(
      baseAssign({
        setupScript: "prepare",
        resolvedArgv: ["codex", "--prompt", "secret prompt"],
      }),
    );
    const system = result.logs
      .filter((chunk) => chunk.stream === "system")
      .map((chunk) => chunk.content);
    expect(system).toEqual([
      "Session started at 2026-08-01T00:00:00.000Z",
      "Claimed worktree wt-1",
      "Checked out ref main",
      "Running setup script...",
      "Setup complete.",
      "Spawning: codex (argument count: 2)",
      "Process exited with code 0",
      "Session completed at 2026-08-01T00:00:00.000Z",
    ]);
    expect(result.logs.some((chunk) => chunk.content.includes("secret prompt"))).toBe(false);
  });

  it("describes missing exit codes and the actual terminal status", async () => {
    const { sessionRunner } = setup({
      async run() {
        return { exitCode: null, timedOut: true, signal: "SIGTERM" };
      },
    });
    const result = await sessionRunner.run(baseAssign());
    expect(result.logs.map((chunk) => chunk.content)).toEqual(
      expect.arrayContaining([
        "Process exited without an exit code",
        "Session timed_out at 2026-08-01T00:00:00.000Z",
      ]),
    );
  });
});
