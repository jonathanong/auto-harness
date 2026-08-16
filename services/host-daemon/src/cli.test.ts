import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { DaemonConfig } from "./config.ts";
import {
  createDefaultRunSessionDeps,
  isDirectInvocation,
  main,
  normalizeCliArgs,
  printUsage,
  runCli,
  setExitCode,
  shutdownLoggerFor,
  type RunSessionDeps,
} from "./cli.ts";

const sampleConfig: DaemonConfig = {
  hostId: "a1",
  logLevel: "info",
  providerAccounts: [],
  commandProfiles: { echo: { argv: ["echo"], appendPrompt: true } },
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
    },
  ],
};

function deps(partial: Partial<RunSessionDeps> = {}): RunSessionDeps & {
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (m) => {
      logs.push(m);
    },
    error: (m) => {
      errors.push(m);
    },
    readFile: () =>
      JSON.stringify({
        sessionId: "s1",
        repositoryId: "repo-1",
        prompt: "p",
        resolvedArgv: ["echo"],
        timeout: 5,
        worktreeId: "wt-1",
      }),
    loadConfig: async () => sampleConfig,
    ensureReady: async () => undefined,
    runSession: async () => ({
      status: "completed",
      exitCode: 0,
      logs: [],
    }),
    ...partial,
  };
}

describe("normalizeCliArgs", () => {
  it("strips a leading -- from pnpm forwarding", () => {
    expect(normalizeCliArgs(["node", "cli", "--", "status"])).toEqual(["status"]);
    expect(normalizeCliArgs(["node", "cli", "status"])).toEqual(["status"]);
  });
});

describe("runCli", () => {
  it("prints usage for help and missing command", async () => {
    const a = deps();
    expect(await runCli(["node", "x", "help"], {}, a)).toBe(0);
    const b = deps();
    expect(await runCli(["node", "x"], {}, b)).toBe(1);
  });

  it("accepts pnpm-style -- before the command", async () => {
    const a = deps();
    expect(await runCli(["node", "x", "--", "status"], {}, a)).toBe(0);
    expect(a.logs[0]).toContain("a1");
  });

  it("status uses env-bootstrapped config", async () => {
    const withCfg = deps();
    expect(await runCli(["node", "x", "status"], { HARNESS_HOST_ID: "a1" }, withCfg)).toBe(0);
    expect(withCfg.logs[0]).toContain("a1");
  });

  it("run-session requires --file and completes", async () => {
    const missing = deps();
    expect(await runCli(["node", "x", "run-session"], {}, missing)).toBe(1);
    expect(missing.errors[0]).toMatch(/--file/);
    const ok = deps();
    expect(await runCli(["node", "x", "run-session", "--file", "s.json"], {}, ok)).toBe(0);
    expect(ok.logs.some((l) => l.includes("completed"))).toBe(true);
  });

  it("unknown command prints usage", async () => {
    const a = deps();
    expect(await runCli(["node", "x", "nope"], {}, a)).toBe(1);
    expect(a.errors[0]).toMatch(/Unknown/);
  });

  it("start reports daemon errors", async () => {
    const a = deps({
      ensureReady: async () => {
        throw new Error("no host config");
      },
    });
    expect(await runCli(["node", "x", "start"], {}, a)).toBe(1);
    expect(a.errors[0]).toMatch(/no host config/);
  });
});

describe("isDirectInvocation / setExitCode", () => {
  it("recognizes only a literal cli.ts/cli.js entrypoint argv", () => {
    expect(isDirectInvocation("/path/to/cli.ts")).toBe(true);
    expect(isDirectInvocation("/path/to/cli.js")).toBe(true);
    expect(isDirectInvocation("/path/to/other.ts")).toBe(false);
    expect(isDirectInvocation(undefined)).toBe(false);
  });

  it("does not match a filename that merely ends with the substring cli.ts", () => {
    // A naive endsWith("cli.ts") check also matches unrelated files like mycli.ts — if
    // such a file imported this module, main() would run unexpectedly on import.
    expect(isDirectInvocation("/tools/mycli.ts")).toBe(false);
    expect(isDirectInvocation("/tools/mycli.js")).toBe(false);
  });

  it("sets process.exitCode to the given value", () => {
    const original = process.exitCode;
    try {
      setExitCode(0);
      expect(process.exitCode).toBe(0);
    } finally {
      process.exitCode = original;
    }
  });
});

describe("shutdownLoggerFor", () => {
  it("passes a message through unchanged", () => {
    const messages: string[] = [];
    shutdownLoggerFor((m) => messages.push(m))("plain message");
    expect(messages).toEqual(["plain message"]);
  });

  it("appends an Error's message", () => {
    const messages: string[] = [];
    shutdownLoggerFor((m) => messages.push(m))("failed", new Error("boom"));
    expect(messages).toEqual(["failed: boom"]);
  });

  it("stringifies a non-Error thrown value", () => {
    const messages: string[] = [];
    shutdownLoggerFor((m) => messages.push(m))("failed", "not an error");
    expect(messages).toEqual(["failed: not an error"]);
  });
});

describe("printUsage / main / defaults", () => {
  it("covers helpers", () => {
    const lines: string[] = [];
    printUsage((m) => lines.push(m));
    expect(lines[0]).toMatch(/local-1/);
    const d = createDefaultRunSessionDeps();
    expect(typeof d.loadConfig).toBe("function");
  });

  it("default deps' log/error/readFile close over the real console and filesystem", () => {
    const d = createDefaultRunSessionDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    d.log("hello");
    d.error("oops");
    expect(log).toHaveBeenCalledWith("hello");
    expect(error).toHaveBeenCalledWith("oops");
    log.mockRestore();
    error.mockRestore();
    expect(d.readFile(fileURLToPath(import.meta.url))).toContain("createDefaultRunSessionDeps");
  });

  it("default deps' ensureReady/runSession close over the real runtime functions", async () => {
    // Not asserting on the outcome — ensureDaemonReady/runAssignedSession are exercised
    // by runtime.ts's own tests. Only proving these wrapper closures forward to them.
    const d = createDefaultRunSessionDeps();
    const empty: DaemonConfig = { ...sampleConfig, repositories: [] };
    await expect(d.ensureReady(empty)).resolves.toBeUndefined();
    const result = await d.runSession(
      empty,
      {
        sessionId: "s",
        repositoryId: "missing",
        prompt: "p",
        resolvedArgv: ["echo"],
        timeout: 1,
        worktreeId: "missing",
      },
      () => undefined,
    );
    expect(result.status).toBe("failed");
  });

  it("main delegates", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["node", "x", "help"])).toBe(0);
    spy.mockRestore();
  });
});
