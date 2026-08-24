/* eslint-disable max-lines -- CLI preflight, boot-recovery, and signal paths share the real daemon harness. */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { emptyDaemonConfig } from "./bootstrap.ts";
import {
  createFileUpdateInstaller,
  readInstalledVersion,
  recoverPendingUpdateBoot,
} from "./agent-updater-install.ts";
import { runCli, type RunSessionDeps } from "./cli.ts";

function runnableUpdateTree(_archivePath: string, destination: string): void {
  const launcher = join(destination, "services/host-daemon/bin");
  mkdirSync(launcher, { recursive: true });
  writeFileSync(join(destination, "package.json"), "{}\n");
  writeFileSync(join(launcher, "auto-harness-host-daemon.mjs"), "// launcher\n");
}

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
  it("keeps a Linux replacement recoverable after a config preflight failure", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "ah-cli-update-"));
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableUpdateTree });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      if (process.platform === "linux") {
        // Linux's root-owned ExecStartPre helper records this attempt immediately
        // before invoking the daemon. The unprivileged CLI intentionally leaves
        // that immutable marker alone, including when its local preflight fails.
        await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      }
      const errors: string[] = [];

      await expect(
        runCli(
          ["node", "x", "start"],
          { HARNESS_UPDATE_INSTALL_DIR: rootDir },
          minimalDeps({
            error: (message) => errors.push(message),
            loadConfig: async () => {
              throw new Error("config preflight failed");
            },
          }),
        ),
      ).resolves.toBe(1);
      expect(errors).toEqual(["config preflight failed"]);

      // The replacement is still unacknowledged, so the next supervisor launch
      // restores the predecessor instead of crash-looping.
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("rolled-back");
      expect(readInstalledVersion(rootDir)).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

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
});
