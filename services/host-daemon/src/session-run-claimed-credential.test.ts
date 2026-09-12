import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ProcessRunner } from "./executor.ts";
import { LogStreamer } from "./log-streamer.ts";
import { runClaimedSession } from "./session-run-claimed.ts";
import { baseAssign } from "../test-helpers/session-runner-test-helpers.ts";

describe("session command credential", () => {
  let cwd: string | undefined;

  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  it("redacts a printed credential even when it is split across chunks", async () => {
    cwd = await mkdtemp(join(tmpdir(), "session-credential-"));
    const credential = "hns_session_ephemeral";
    const commandRunner: ProcessRunner = {
      async run(options) {
        options.onChunk?.({ stream: "stdout", data: "token=hns_session_" });
        options.onChunk?.({ stream: "stdout", data: "ephemeral\n" });
        options.onChunk?.({ stream: "stderr", data: `${credential}\n` });
        return { exitCode: 0, timedOut: false, signal: null };
      },
    };
    const logs: Array<{ content: string }> = [];
    await runClaimedSession(
      commandRunner,
      new LogStreamer("sess-2", "attempt-1", (chunk) => logs.push(chunk)),
      logs as never,
      baseAssign({ sessionApiKey: credential }),
      {
        repository: { id: "repo-1", path: "/repo", defaultBranch: "main", worktrees: [] },
        worktree: { id: "wt-1", name: "wt", path: cwd, labels: [] },
        cwd,
      },
      undefined,
      () => false,
      () => 1_000,
      commandRunner,
      process.env,
      undefined,
      { apiUrl: "http://127.0.0.1:7420", apiKey: "host-secret" },
    );
    const transcript = logs.map((chunk) => chunk.content).join("");
    expect(transcript).not.toContain(credential);
    expect(transcript.match(/\[session credential redacted\]/g)).toHaveLength(2);
  });
});
