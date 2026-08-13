import { describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "./session-runner-test-helpers.ts";

const claimed = {
  repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
  worktree: { id: "wt-1", name: "wt", path: "/wt", labels: [] },
  cwd: "/wt",
};

describe("claimed session PTY output", () => {
  it("captures and redacts stderr-scoped resume references from the merged stream", async () => {
    const logs = [];
    const systemRunner: ProcessRunner = {
      async run() {
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const commandRunner: ProcessRunner = {
      outputStreams: "merged",
      async run(options) {
        options.onChunk({ stream: "stdout", data: "resume: opaque-native-ref\r\nready\r\n" });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };

    const outcome = await runClaimedSession(
      systemRunner,
      new LogStreamer("session-1", (chunk) => logs.push(chunk)),
      logs,
      baseAssign({ resumeRefCapture: { stream: "stderr", linePrefix: "resume: " } }),
      claimed,
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
    );

    expect(outcome).toMatchObject({ status: "completed", cliResumeRef: "opaque-native-ref" });
    expect(logs.map((chunk) => chunk.content).join("\n")).toContain(
      "[CLI resume reference redacted]\n",
    );
    expect(logs.some((chunk) => chunk.content.includes("opaque-native-ref"))).toBe(false);
  });
});
