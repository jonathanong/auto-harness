import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
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
          HARNESS_CHILD_ENV_ALLOWLIST: "SECOND_TOKEN,FIRST_TOKEN",
          FIRST_TOKEN: "first",
          SECOND_TOKEN: "second",
        },
        deps,
      );
      await waitFor(() => proc.hasListener("SIGINT") && proc.hasListener("SIGTERM"));
      expect(server.registeredEnvironmentNames()).toEqual(["FIRST_TOKEN", "SECOND_TOKEN"]);
      proc.fire("SIGINT");
      expect(await resultPromise).toBe(0);
    } finally {
      await server.close();
    }
  });
});
