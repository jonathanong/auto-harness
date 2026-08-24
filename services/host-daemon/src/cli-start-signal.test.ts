/* eslint-disable max-lines -- real start signal coverage shares one loopback harness. */
import { createServer } from "node:http";

import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { emptyDaemonConfig } from "./bootstrap.ts";
import { runCli, type RunSessionDeps } from "./cli.ts";

/**
 * `start`'s signal-handling path, exercised against a real startDaemon and a local WS
 * harness rather than mocked — services/host-daemon has no precedent for mocking
 * start-daemon.ts, and AGENTS.md reserves mocking for host CLI-tool boundaries.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Minimal accepting WS server so `start`'s real startDaemon has somewhere to register. */
async function acceptingServer(): Promise<{
  port: number;
  registeredEnvironmentNames(): string[] | undefined;
  close(): Promise<void>;
}> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  let environmentNames: string[] | undefined;
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        type?: string;
        hostId?: string;
        runtime?: { environmentNames?: string[] };
      };
      if (message.type === "host:register") {
        environmentNames = message.runtime?.environmentNames;
        socket.send(JSON.stringify({ type: "host:registered", hostId: message.hostId }));
      } else if (message.type === "host:status") {
        // Acknowledges the drain announcement `stop()` sends; without this
        // beginDrain() waits forever for a host:draining reply.
        socket.send(JSON.stringify({ type: "host:draining", hostId: message.hostId }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    port: address.port,
    registeredEnvironmentNames: () => environmentNames,
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

/**
 * Captures handlers registered via `on()`/`off()` without touching the real process.
 * Shaped like modules/shared/src/process-lifecycle.test.ts's own fakeProcess, since this
 * is passed straight through to that module's onShutdownSignal.
 */
function fakeProcess(): Pick<NodeJS.Process, "on" | "off" | "exit"> & {
  fire(event: string): void;
  hasListener(event: string): boolean;
} {
  const handlers = new Map<string, () => void>();
  return {
    on(event: string, handler: () => void) {
      handlers.set(event, handler);
      return this as never;
    },
    off(event: string) {
      handlers.delete(event);
      return this as never;
    },
    exit(code?: number) {
      throw new Error(`unexpected forced exit(${code ?? 0}) in test`);
    },
    fire(event: string) {
      handlers.get(event)?.();
    },
    hasListener(event: string) {
      return handlers.has(event);
    },
  };
}

function minimalDeps(overrides: Partial<RunSessionDeps>): RunSessionDeps {
  return {
    log: () => undefined,
    error: () => undefined,
    readFile: () => "",
    loadConfig: async () => emptyDaemonConfig({ hostId: "unused", logLevel: "info" }),
    ensureReady: async () => undefined,
    runSession: async () => ({ status: "completed", exitCode: 0, logs: [] }),
    installService: () => 0,
    uninstallService: () => 0,
    statusService: () => ({ state: "unknown", reason: "not used by start" }),
    fetchHostStatus: async () => ({
      reachable: false,
      hostId: "unused",
      online: null,
      connectedAt: null,
      draining: null,
      gitReady: null,
      reason: "not used by start",
    }),
    ...overrides,
  };
}

describe("runCli start signal handling", () => {
  it("registers real signal handlers and resolves once one fires", async () => {
    const server = await acceptingServer();
    const proc = fakeProcess();
    const tokenNames = Array.from(
      { length: 256 },
      (_, index) => `TOKEN_${String(index).padStart(3, "0")}`,
    );
    try {
      const deps = minimalDeps({
        process: proc,
        ensureReady: async () => ({
          daemonVersion: "test",
          gitVersion: "2.50.0",
          gitReady: true,
        }),
        loadConfig: async () =>
          emptyDaemonConfig({
            hostId: "cli-start-test",
            apiUrl: `http://127.0.0.1:${server.port}`,
            logLevel: "info",
          }),
      });
      const resultPromise = runCli(
        ["node", "x", "start", "--ws", `http://127.0.0.1:${server.port}`],
        {
          HARNESS_CHILD_ENV_ALLOWLIST: tokenNames.join(","),
          PATH: "/bin",
          ...Object.fromEntries(tokenNames.map((name) => [name, name])),
        },
        deps,
      );
      await waitFor(() => proc.hasListener("SIGINT") && proc.hasListener("SIGTERM"));
      expect(server.registeredEnvironmentNames()).toEqual(["PATH", ...tokenNames]);
      proc.fire("SIGINT");
      expect(await resultPromise).toBe(0);
    } finally {
      await server.close();
    }
  });

  it.each([
    ["default timeout", {}],
    ["invalid timeout", { HARNESS_SHUTDOWN_TIMEOUT_MS: "invalid" }],
    ["positive timeout", { HARNESS_SHUTDOWN_TIMEOUT_MS: "1000" }],
  ])("handles %s without optional start wiring", async (_name, timeoutEnv) => {
    const server = await acceptingServer();
    const on = vi.spyOn(process, "on");
    const off = vi.spyOn(process, "off");
    try {
      const result = runCli(
        ["node", "x", "start"],
        {
          ...timeoutEnv,
          HARNESS_CHILD_ENV_ALLOWLIST: "",
        },
        minimalDeps({
          loadConfig: async () =>
            emptyDaemonConfig({
              hostId: "cli-start-optional-test",
              apiUrl: `http://127.0.0.1:${server.port}`,
              logLevel: "info",
            }),
          ensureReady: async () => undefined,
        }),
      );
      await waitFor(() => on.mock.calls.some(([event]) => event === "SIGINT"));
      const handler = on.mock.calls.find(([event]) => event === "SIGINT")?.[1] as
        | (() => void)
        | undefined;
      handler?.();
      expect(await result).toBe(0);
    } finally {
      on.mockRestore();
      off.mockRestore();
      await server.close();
    }
  });

  it("rejects an oversized complete environment report, including LC_* names", async () => {
    const tokenNames = Array.from(
      { length: 512 },
      (_, index) => `TOKEN_${String(index).padStart(3, "0")}`,
    );
    const errors: string[] = [];
    const deps = minimalDeps({
      error: (message) => errors.push(message),
      ensureReady: async () => ({
        daemonVersion: "test",
        gitVersion: "2.50.0",
        gitReady: true,
      }),
    });
    await expect(
      runCli(
        ["node", "x", "start"],
        {
          HARNESS_CHILD_ENV_ALLOWLIST: tokenNames.join(","),
          LC_ALL: "C",
          ...Object.fromEntries(tokenNames.map((name) => [name, name])),
        },
        deps,
      ),
    ).resolves.toBe(1);
    expect(errors).toEqual([
      "child environment exceeds runtime report limits (512 names, 128 characters per name)",
    ]);
  });

  it("rejects an overlong name in the complete environment report", async () => {
    const overlongName = `LC_${"A".repeat(126)}`;
    const errors: string[] = [];
    const deps = minimalDeps({
      error: (message) => errors.push(message),
      ensureReady: async () => ({
        daemonVersion: "test",
        gitVersion: "2.50.0",
        gitReady: true,
      }),
    });
    await expect(runCli(["node", "x", "start"], { [overlongName]: "C" }, deps)).resolves.toBe(1);
    expect(errors).toEqual([
      "child environment exceeds runtime report limits (512 names, 128 characters per name)",
    ]);
  });

  it("reports non-Error start failures safely", async () => {
    const errors: string[] = [];
    const deps = minimalDeps({
      error: (message) => errors.push(message),
      ensureReady: async () => {
        throw "string start failure";
      },
    });
    await expect(runCli(["node", "x", "start"], {}, deps)).resolves.toBe(1);
    expect(errors).toEqual(["string start failure"]);
  });
});
