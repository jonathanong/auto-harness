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
  commandProfiles: { echo: { argv: ["echo"], appendPrompt: true } },
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
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
        commandProfile: "echo",
        timeout: 5,
        worktreeId: "wt-1",
      }),
    loadConfig: () => sampleConfig,
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

  it("status dumps inventory", async () => {
    const withCfg = deps();
    expect(await runCli(["node", "x", "status", "--config", "c.json"], {}, withCfg)).toBe(0);
    expect(withCfg.logs[0]).toContain("a1");
    const noCfg = deps();
    expect(await runCli(["node", "x", "status"], {}, noCfg)).toBe(0);
  });

  it("run-session success and failure", async () => {
    const ok = deps();
    expect(await runCli(["node", "x", "run-session", "--file", "s.json"], {}, ok)).toBe(0);
    expect(ok.logs.at(-1)).toContain("completed");

    const okCfg = deps();
    expect(
      await runCli(
        ["node", "x", "run-session", "--file", "s.json", "--config", "c.json"],
        {},
        okCfg,
      ),
    ).toBe(0);

    const bad = deps({
      runSession: async () => ({
        status: "failed",
        exitCode: 1,
        logs: [],
      }),
    });
    expect(await runCli(["node", "x", "run-session", "--file", "s.json"], {}, bad)).toBe(1);

    const missing = deps();
    expect(await runCli(["node", "x", "run-session"], {}, missing)).toBe(1);
  });

  it("start requires apiUrl and unknown command", async () => {
    const a = deps();
    // sampleConfig has no apiUrl → start fails
    expect(await runCli(["node", "x", "start"], {}, a)).toBe(1);
    expect(a.errors.some((e) => e.includes("apiUrl"))).toBe(true);
    const b = deps();
    expect(await runCli(["node", "x", "nope"], {}, b)).toBe(1);
  });

  it("printUsage and main", async () => {
    const lines: string[] = [];
    printUsage((m) => lines.push(m));
    expect(lines.join("")).toContain("Usage");
    expect(await main(["node", "x", "help"])).toBe(0);
  });

  it("createDefaultRunSessionDeps wires console and loaders", async () => {
    const d = createDefaultRunSessionDeps();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    d.log("hello");
    d.error("err");
    expect(log).toHaveBeenCalledWith("hello");
    expect(error).toHaveBeenCalledWith("err");
    log.mockRestore();
    error.mockRestore();
    expect(() => d.readFile("/no/such/auto-harness-file")).toThrow();
    const ready = vi
      .spyOn(await import("./runtime.ts"), "ensureAgentReady")
      .mockResolvedValue(undefined);
    const run = vi.spyOn(await import("./runtime.ts"), "runAssignedSession").mockResolvedValue({
      status: "completed",
      exitCode: 0,
      logs: [],
    });
    const d2 = createDefaultRunSessionDeps();
    await d2.ensureReady(sampleConfig);
    await d2.runSession(
      sampleConfig,
      {
        sessionId: "s",
        repositoryId: "repo-1",
        prompt: "p",
        commandProfile: "echo",
        timeout: 1,
        worktreeId: "wt-1",
      },
      () => undefined,
    );
    expect(ready).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
    ready.mockRestore();
    run.mockRestore();
  });
});
