import { describe, expect, it, vi } from "vitest";

import type { AgentConfig } from "./config.ts";
import {
  createDefaultRunSessionDeps,
  main,
  normalizeCliArgs,
  printUsage,
  runCli,
  type RunSessionDeps,
} from "./cli.ts";

const sampleConfig: AgentConfig = {
  agentId: "a1",
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
    expect(await runCli(["node", "x", "status"], { HARNESS_AGENT_ID: "a1" }, withCfg)).toBe(0);
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

describe("printUsage / main / defaults", () => {
  it("covers helpers", () => {
    const lines: string[] = [];
    printUsage((m) => lines.push(m));
    expect(lines[0]).toMatch(/local-1/);
    const d = createDefaultRunSessionDeps();
    expect(typeof d.loadConfig).toBe("function");
  });

  it("main delegates", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["node", "x", "help"])).toBe(0);
    spy.mockRestore();
  });
});
