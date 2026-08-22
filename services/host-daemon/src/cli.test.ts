/* eslint-disable max-lines -- status matrix coverage stays adjacent to CLI behavior. */
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  createDefaultRunSessionDeps,
  isDirectInvocation,
  main,
  normalizeCliArgs,
  printUsage,
  runCli,
  setExitCode,
  shutdownLoggerFor,
} from "./cli.ts";
import { deps, sampleConfig } from "./cli-test-helpers.ts";
import type { DaemonConfig } from "./config.ts";
import { installHostService, uninstallHostService } from "./host-service.ts";

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

  it("reports service, exact host, and inventory separately", async () => {
    const a = deps({
      statusService: () => ({ state: "running", reason: "systemd unit is running" }),
      fetchHostStatus: async () => ({
        reachable: true,
        hostId: "a1",
        online: true,
        connectedAt: "2026-08-21T10:00:00.000Z",
        draining: false,
        gitReady: true,
        reason: "host status received",
      }),
    });
    expect(await runCli(["node", "x", "status"], {}, a)).toBe(0);
    expect(JSON.parse(a.logs[0] ?? "")).toMatchObject({
      status: "ok",
      service: { state: "running" },
      controlPlane: { hostId: "a1", online: true, draining: false, gitReady: true },
      inventory: { hostId: "a1" },
    });
  });

  it("preserves inventory-only output with --config-only", async () => {
    const a = deps({
      statusService: () => {
        throw new Error("must not query service");
      },
      fetchHostStatus: async () => {
        throw new Error("must not query control plane");
      },
    });
    expect(await runCli(["node", "x", "status", "--config-only"], {}, a)).toBe(0);
    expect(JSON.parse(a.logs[0] ?? "")).toEqual({
      hostId: "a1",
      repositories: [
        {
          id: "repo-1",
          path: "/repo",
          worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
        },
      ],
    });
  });

  it.each([
    ["offline", { controlPlane: { online: false } }, "offline"],
    ["draining", { controlPlane: { online: true, draining: true } }, "draining"],
    ["missing service", { service: { state: "missing", reason: "not installed" } }, "missing"],
    ["failed service", { service: { state: "failed", reason: "failed" } }, "failed"],
    ["unreachable API", { controlPlane: { reachable: false } }, "unreachable"],
    [
      "legacy readiness",
      { controlPlane: { online: true, draining: false, gitReady: null } },
      "legacy",
    ],
  ] as const)("returns failure for %s", async (_name, override, _reason) => {
    const a = deps({
      statusService: () => override.service ?? { state: "running", reason: "running" },
      fetchHostStatus: async () => ({
        reachable: true,
        hostId: "a1",
        online: true,
        connectedAt: "now",
        draining: false,
        gitReady: true,
        reason: "host status received",
        ...override.controlPlane,
      }),
    });
    expect(await runCli(["node", "x", "status"], {}, a)).toBe(1);
    expect(JSON.parse(a.logs[0] ?? "").status).toBe("failed");
  });

  it("does not disclose API keys or raw status errors", async () => {
    const a = deps({
      loadConfig: async () => ({ ...sampleConfig, apiKey: "secret-token" }),
      fetchHostStatus: async () => {
        throw new Error("secret-token raw failure");
      },
    });
    expect(await runCli(["node", "x", "status"], {}, a)).toBe(1);
    expect(a.logs.join("\n")).not.toContain("secret-token");
    expect(a.errors.join("\n")).not.toContain("secret-token");
  });

  it("fails closed when config loading exceeds the status deadline", async () => {
    vi.useFakeTimers();
    try {
      const a = deps({ loadConfig: () => new Promise<DaemonConfig>(() => undefined) });
      const result = runCli(["node", "x", "status"], {}, a);
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(result).resolves.toBe(1);
      expect(JSON.parse(a.logs[0] ?? "").service.state).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails safely when config loading fails", async () => {
    const a = deps({
      loadConfig: async () => {
        throw new Error("inventory request failed");
      },
      statusService: () => ({ state: "unknown", reason: "not available" }),
      fetchHostStatus: async (identity) => ({
        reachable: false,
        hostId: identity.hostId,
        online: null,
        connectedAt: null,
        draining: null,
        gitReady: null,
        reason: "control plane is unreachable",
      }),
    });
    expect(await runCli(["node", "x", "status"], {}, a)).toBe(1);
    expect(JSON.parse(a.logs[0] ?? "").inventory).toBeNull();
    expect(a.errors).toEqual([]);
  });

  it("reports a safe error when config-only loading fails", async () => {
    const a = deps({
      loadConfig: async () => {
        throw new Error("secret-token inventory failure");
      },
    });
    expect(await runCli(["node", "x", "status", "--config-only"], {}, a)).toBe(1);
    expect(a.errors).toEqual(["Cannot load daemon configuration"]);
    expect(a.errors.join("\n")).not.toContain("secret-token");
  });

  it("rejects an unexpectedly empty config in config-only mode", async () => {
    const a = deps({ loadConfig: async () => undefined as never });
    expect(await runCli(["node", "x", "status", "--config-only"], {}, a)).toBe(1);
    expect(a.errors).toEqual(["Cannot load daemon configuration"]);
  });

  it("maps a thrown service-manager status to unknown", async () => {
    const a = deps({
      statusService: (opts) => {
        opts.log("ignored service output");
        opts.error("ignored service error");
        throw new Error("raw service-manager output");
      },
    });
    expect(await runCli(["node", "x", "status"], {}, a)).toBe(1);
    expect(JSON.parse(a.logs[0] ?? "").service).toEqual({
      state: "unknown",
      reason: "service status could not be determined",
    });
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
    expect(lines[0]).toMatch(/install-service/);
    expect(lines[0]).toMatch(/uninstall-service/);
    expect(lines[0]).toMatch(/Every platform validates/);
    const d = createDefaultRunSessionDeps();
    expect(typeof d.loadConfig).toBe("function");
    expect(d.installService).toBe(installHostService);
    expect(d.uninstallService).toBe(uninstallHostService);
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

  it("default deps' host status closure forwards the fetch signal", async () => {
    const d = createDefaultRunSessionDeps();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(
        d.fetchHostStatus(
          { hostId: "host", apiUrl: "https://control.example" },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ reachable: true, online: null });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("default deps' ensureReady/runSession close over the real runtime functions", async () => {
    // Not asserting on the outcome — ensureDaemonReady/runAssignedSession are exercised
    // by runtime.ts's own tests. Only proving these wrapper closures forward to them.
    const d = createDefaultRunSessionDeps();
    const empty: DaemonConfig = { ...sampleConfig, repositories: [] };
    await expect(d.ensureReady(empty)).resolves.toMatchObject({ gitReady: true });
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
