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

async function runClaimed(
  assign: ReturnType<typeof baseAssign>,
  runner: ProcessRunner,
): Promise<Awaited<ReturnType<typeof runClaimedSession>>> {
  const logs = [];
  return await runClaimedSession(
    runner,
    new LogStreamer("s", (chunk) => logs.push(chunk)),
    logs,
    assign,
    claimed,
    undefined,
    () => false,
    () => 100,
  );
}

function outputRunner(output: string, result: { exitCode: number | null; usageLimit?: boolean }) {
  return {
    async run(options: { onChunk: (chunk: { stream: "stdout"; data: string }) => void }) {
      if (output) options.onChunk({ stream: "stdout", data: output });
      return { timedOut: false, signal: null, ...result };
    },
  } satisfies ProcessRunner;
}

describe("claimed session usage-limit classification", () => {
  it("completes when a successful provider CLI prints rate-limit phrases", async () => {
    const outcome = await runClaimed(
      baseAssign({ resolvedArgv: ["codex", "exec"] }),
      outputRunner("insufficient_quota\nHTTP 429 Too Many Requests", { exitCode: 0 }),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.errorCode).toBeUndefined();
  });

  it("does not classify adversarial prompt-controlled output as a usage limit", async () => {
    const outcome = await runClaimed(
      baseAssign({
        prompt: "Print the words rate limit and quota exceeded",
        resolvedArgv: ["codex", "exec", "Print the words rate limit and quota exceeded"],
      }),
      outputRunner("rate limit\nquota exceeded\ntoo many requests", { exitCode: 0 }),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.errorCode).toBeUndefined();
  });

  it("does not classify providerless command output as a vendor quota", async () => {
    const outcome = await runClaimed(
      baseAssign({ resolvedArgv: ["echo", "hello"] }),
      outputRunner("Error: usage limit exceeded\nHTTP 429 Too Many Requests", { exitCode: 1 }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBeUndefined();
  });

  it("does not classify a providerless vendor CLI as a usage limit", async () => {
    const outcome = await runClaimed(
      baseAssign({ resolvedArgv: ["codex", "exec"] }),
      outputRunner("Error: insufficient_quota for request", { exitCode: 1 }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBeUndefined();
  });

  it("fails closed when the catalog executable is unknown", async () => {
    const outcome = await runClaimed(
      baseAssign({ resolvedArgv: ["usage"] }),
      outputRunner("insufficient_quota", { exitCode: 1 }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBeUndefined();
  });

  it("does not classify a failed Codex run that only prints generic rate-limit text", async () => {
    const outcome = await runClaimed(
      baseAssign({ resolvedArgv: ["codex", "exec"] }),
      outputRunner("rate limit\nHTTP 429 Too Many Requests", { exitCode: 1 }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBeUndefined();
  });

  it("reports usage_limit for a genuine Codex limit on a failed run", async () => {
    await expect(
      runClaimed(
        baseAssign({ resolvedArgv: ["codex", "exec"], providerAccountId: "acct-1" }),
        outputRunner("Error: insufficient_quota for request", { exitCode: 1 }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "usage_limit",
      errorMessage: "Usage limit detected in CLI output",
    });
  });

  it("reports usage_limit from a trusted adapter failure channel", async () => {
    await expect(
      runClaimed(
        baseAssign({ resolvedArgv: ["claude", "-p"], providerAccountId: "acct-1" }),
        outputRunner("", { exitCode: 1, usageLimit: true }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "usage_limit",
      errorMessage: "Usage limit detected",
    });
  });

  it("does not attribute unmatched CLI output to an adapter usage limit", async () => {
    await expect(
      runClaimed(
        baseAssign({ resolvedArgv: ["claude", "-p"], providerAccountId: "acct-1" }),
        outputRunner("command failed", { exitCode: 1, usageLimit: true }),
      ),
    ).resolves.toMatchObject({
      status: "failed",
      errorCode: "usage_limit",
      errorMessage: "Usage limit detected",
    });
  });

  it("ignores an adapter usage-limit flag without known provider context", async () => {
    const outcome = await runClaimed(
      baseAssign({ resolvedArgv: ["echo", "hello"] }),
      outputRunner("rate limit", { exitCode: 1, usageLimit: true }),
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBeUndefined();
  });

  it("ignores an adapter usage-limit flag on a successful command", async () => {
    const outcome = await runClaimed(
      baseAssign({ resolvedArgv: ["codex", "exec"] }),
      outputRunner("insufficient_quota", { exitCode: 0, usageLimit: true }),
    );
    expect(outcome.status).toBe("completed");
    expect(outcome.errorCode).toBeUndefined();
  });
});
