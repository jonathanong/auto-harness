/* eslint-disable max-lines -- result probe failures share one compact process-runner fixture. */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessRunner, RunProcessOptions } from "./executor.ts";
import { collectSessionResult, SESSION_RESULT_PROBE_DEADLINE_MS } from "./session-result.ts";

function runnerFor(responses: Record<string, string>): ProcessRunner {
  return {
    async run(options: RunProcessOptions) {
      const key = options.argv.slice(1, 4).join(" ");
      const stdout = responses[key] ?? "";
      if (stdout) options.onChunk({ stream: "stdout", data: stdout });
      return { exitCode: 0, timedOut: false, signal: null };
    },
  };
}

function runnerWith(
  run: (
    options: RunProcessOptions,
  ) => Promise<{ exitCode: number | null; timedOut: false; signal: null }>,
): ProcessRunner {
  return { run };
}

describe("collectSessionResult", () => {
  afterEach(() => vi.useRealTimers());

  it("collects sorted NUL-delimited git facts and an exactly-one PR after a terminal hook", async () => {
    const result = await collectSessionResult({
      runner: runnerFor({
        "symbolic-ref --quiet --short": "feature/result\n",
        "diff --name-only -z": "z.ts\0a.ts\0",
        "ls-files --others --exclude-standard": "new.ts\0",
        "pr list --head": '[{"url":"https://github.com/example/repo/pull/42"}]',
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      agentSummary: "Finished the implementation.",
      environment: process.env,
    });

    expect(result).toEqual({
      summary: "Finished the implementation.",
      summarySource: "agent",
      branch: "feature/result",
      filesChanged: ["a.ts", "new.ts", "z.ts"],
      pullRequestUrl: "https://github.com/example/repo/pull/42",
    });
  });

  it("omits unavailable probes while retaining a deterministic harness summary", async () => {
    const result = await collectSessionResult({
      runner: runnerFor({}),
      cwd: process.cwd(),
      status: "failed",
      environment: process.env,
    });

    expect(result).toEqual({ summary: "Session failed", summarySource: "harness" });
  });

  it("uses the child-environment allowlist for every repository result probe", async () => {
    const probeEnvironments: NodeJS.ProcessEnv[] = [];
    const source: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: "/safe-home",
      HARNESS_API_KEY: "daemon-secret",
      HARNESS_CHILD_ENV_ALLOWLIST: "VISIBLE_TO_REPOSITORY",
      VISIBLE_TO_REPOSITORY: "allowed",
      UNRELATED_DAEMON_VALUE: "not-forwarded",
    };
    const result = await collectSessionResult({
      runner: runnerWith(async (options) => {
        probeEnvironments.push(options.env ?? {});
        if (options.argv.includes("symbolic-ref")) {
          options.onChunk({ stream: "stdout", data: "feature/result\n" });
        }
        return {
          exitCode: options.argv.includes("pr") ? 1 : 0,
          timedOut: false,
          signal: null,
        };
      }),
      cwd: process.cwd(),
      status: "completed",
      environment: source,
    });

    expect(result).toMatchObject({ branch: "feature/result" });
    expect(probeEnvironments).toHaveLength(2);
    for (const environment of probeEnvironments) {
      expect(environment).toMatchObject({
        PATH: source.PATH,
        HOME: "/safe-home",
        VISIBLE_TO_REPOSITORY: "allowed",
      });
      expect(environment).not.toHaveProperty("HARNESS_API_KEY");
      expect(environment).not.toHaveProperty("HARNESS_CHILD_ENV_ALLOWLIST");
      expect(environment).not.toHaveProperty("UNRELATED_DAEMON_VALUE");
    }
  });

  it("retains only the summary when probe-environment sanitization rejects its source", async () => {
    const runner: ProcessRunner = { run: vi.fn() };
    const result = await collectSessionResult({
      runner,
      cwd: process.cwd(),
      status: "failed",
      agentSummary: "The agent reported a failure.",
      environment: { HARNESS_CHILD_ENV_ALLOWLIST: "not-a-valid-name!" },
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect(result).toEqual({
      summary: "The agent reported a failure.",
      summarySource: "agent",
    });
  });

  it("omits an oversized branch probe rather than recording a partial branch name", async () => {
    const result = await collectSessionResult({
      runner: runnerWith(async (options) => {
        if (options.argv.includes("symbolic-ref")) {
          options.onChunk({ stream: "stderr", data: "ignored diagnostic" });
          options.onChunk({ stream: "stdout", data: "x".repeat(1_025) });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      }),
      cwd: process.cwd(),
      status: "completed",
      environment: process.env,
    });

    expect(result).toEqual({ summary: "Session completed", summarySource: "harness" });
  });

  it("bounds files and rejects ambiguous or invalid PR associations", async () => {
    const files = Array.from(
      { length: 257 },
      (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(4 * 1024 - 4)}`,
    ).join("\0");
    const result = await collectSessionResult({
      runner: runnerFor({
        "symbolic-ref --quiet --short": "feature/result\n",
        "diff --name-only -z": `${files}\0`,
        "ls-files --others --exclude-standard": "",
        "pr list --head":
          '[{"url":"https://github.com/example/repo/pull/1"},{"url":"ftp://invalid"}]',
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });

    // The whole result has a 32 KiB budget, so long paths leave room for a
    // smaller prefix than the 256-item count cap. It must still be present.
    expect(result.filesChanged?.length).toBeGreaterThan(0);
    expect(result.filesChanged?.length).toBeLessThanOrEqual(256);
    expect(result.filesChanged?.[0]).toMatch(/^000-/);
    expect(result.filesChangedTruncated).toBe(true);
    expect(result.pullRequestUrl).toBeUndefined();
  });

  it("keeps a complete prefix when a git path capture fills, ignoring stderr", async () => {
    const fullPath = `a-${"x".repeat(4 * 1024 - 2)}\0`;
    const result = await collectSessionResult({
      runner: runnerWith(async (options) => {
        if (options.argv.includes("symbolic-ref")) {
          options.onChunk({ stream: "stdout", data: "branch\n" });
        } else if (options.argv.includes("diff")) {
          options.onChunk({ stream: "stdout", data: fullPath.repeat(256) });
          options.onChunk({ stream: "stderr", data: "ignored diagnostic" });
          options.onChunk({ stream: "stdout", data: "later.ts\0" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });

    expect(result.filesChanged?.length).toBeGreaterThan(0);
    expect(result.filesChangedTruncated).toBe(true);
  });

  it("omits file facts for a failed git probe and marks individually oversized paths", async () => {
    const nonzero = await collectSessionResult({
      runner: runnerWith(async (options) => {
        if (options.argv.includes("symbolic-ref"))
          options.onChunk({ stream: "stdout", data: "branch\n" });
        return {
          exitCode: options.argv.includes("diff") ? null : 0,
          timedOut: false,
          signal: null,
        };
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });
    expect(nonzero.filesChanged).toBeUndefined();

    const thrownProbe = await collectSessionResult({
      runner: runnerWith(async (options) => {
        if (options.argv.includes("symbolic-ref"))
          options.onChunk({ stream: "stdout", data: "branch\n" });
        if (options.argv.includes("diff")) throw new Error("git transport failed");
        return { exitCode: 0, timedOut: false, signal: null };
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });
    expect(thrownProbe.filesChanged).toBeUndefined();

    const oversized = await collectSessionResult({
      runner: runnerFor({
        "symbolic-ref --quiet --short": "branch\n",
        "diff --name-only -z": `${"x".repeat(4 * 1024 + 1)}\0ok.ts\0`,
        "ls-files --others --exclude-standard": "",
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });
    expect(oversized).toMatchObject({ filesChanged: ["ok.ts"], filesChangedTruncated: true });
  });

  it("degrades malformed branch and PR probes without changing the harness result", async () => {
    const branchFailure = await collectSessionResult({
      runner: runnerWith(async (options) => {
        if (options.argv.includes("symbolic-ref")) throw new Error("git unavailable");
        return { exitCode: 0, timedOut: false, signal: null };
      }),
      cwd: process.cwd(),
      status: "failed",
      environment: process.env,
    });
    expect(branchFailure).toEqual({ summary: "Session failed", summarySource: "harness" });

    const prPayloads = [
      "not-json",
      "{}",
      "[null]",
      "[42]",
      "[{}]",
      '[{"url":"ftp://example.test/pull/1"}]',
    ];
    for (const payload of prPayloads) {
      const result = await collectSessionResult({
        runner: runnerFor({
          "symbolic-ref --quiet --short": "branch\n",
          "pr list --head": payload,
        }),
        cwd: process.cwd(),
        status: "completed",
        environment: process.env,
      });
      expect(result.pullRequestUrl).toBeUndefined();
    }

    const thrown = await collectSessionResult({
      runner: runnerWith(async (options) => {
        if (options.argv.includes("symbolic-ref"))
          options.onChunk({ stream: "stdout", data: "branch\n" });
        if (options.argv.includes("pr")) throw new Error("gh unavailable");
        return { exitCode: 0, timedOut: false, signal: null };
      }),
      cwd: process.cwd(),
      status: "completed",
      environment: process.env,
    });
    expect(thrown.pullRequestUrl).toBeUndefined();

    const tooLarge = await collectSessionResult({
      runner: runnerWith(async (options) => {
        if (options.argv.includes("symbolic-ref"))
          options.onChunk({ stream: "stdout", data: "branch\n" });
        if (options.argv.includes("pr")) {
          options.onChunk({ stream: "stdout", data: "x".repeat(8 * 1024) });
          options.onChunk({ stream: "stdout", data: "ignored" });
        }
        return { exitCode: 0, timedOut: false, signal: null };
      }),
      cwd: process.cwd(),
      status: "completed",
      environment: process.env,
    });
    expect(tooLarge.pullRequestUrl).toBeUndefined();
  });

  it("includes available facts in a deterministic plural harness summary", async () => {
    const result = await collectSessionResult({
      runner: runnerFor({
        "symbolic-ref --quiet --short": "branch\n",
        "diff --name-only -z": "one.ts\0two.ts\0",
        "ls-files --others --exclude-standard": "",
        "pr list --head": '[{"url":"https://example.test/pull/1"}]',
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });

    expect(result.summary).toBe(
      "Session completed; on branch; 2 files changed; pull request found",
    );
  });

  it("uses singular file wording and accepts an HTTP pull request URL", async () => {
    const result = await collectSessionResult({
      runner: runnerFor({
        "symbolic-ref --quiet --short": "branch\n",
        "diff --name-only -z": "one.ts\0",
        "ls-files --others --exclude-standard": "",
        "pr list --head": '[{"url":"http://example.test/pull/1"}]',
      }),
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });

    expect(result.summary).toBe("Session completed; on branch; 1 file changed; pull request found");
  });

  it("uses one short deadline to omit stalled Git facts without delaying terminal status", async () => {
    vi.useFakeTimers();
    const calls: RunProcessOptions[] = [];
    const runner: ProcessRunner = {
      run(options) {
        calls.push(options);
        if (options.argv.includes("symbolic-ref")) {
          options.onChunk({ stream: "stdout", data: "feature/result\n" });
          return Promise.resolve({ exitCode: 0, timedOut: false, signal: null });
        }
        return new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => resolve({ exitCode: null, timedOut: false, cancelled: true, signal: null }),
            { once: true },
          );
        });
      },
    };

    const collecting = collectSessionResult({
      runner,
      cwd: process.cwd(),
      status: "completed",
      baseline: "0123456789012345678901234567890123456789",
      environment: process.env,
    });
    await vi.advanceTimersByTimeAsync(SESSION_RESULT_PROBE_DEADLINE_MS);

    await expect(collecting).resolves.toEqual({
      summary: "Session completed; on feature/result",
      summarySource: "harness",
      branch: "feature/result",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.signal).toBe(calls[1]?.signal);
    expect(calls[1]?.signal).toBe(calls[2]?.signal);
    expect(calls.every((call) => call.timeoutMs <= SESSION_RESULT_PROBE_DEADLINE_MS)).toBe(true);
    expect(calls.every((call) => call.signal?.aborted)).toBe(true);
    expect(calls.some((call) => call.argv.includes("pr"))).toBe(false);
  });
});
