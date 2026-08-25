/* eslint-disable max-lines -- startup, registration, and replacement-boot cases share one WebSocket harness. */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import {
  confirmPendingUpdateBoot,
  createFileUpdateInstaller,
  readInstalledVersion,
  recoverPendingUpdateBoot,
} from "./agent-updater-install.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";
import {
  prepareDaemonUpdateBoot,
  prepareStableDaemonUpdateBoot,
  requestSupervisorRestart,
  startDaemon,
} from "./start-daemon.ts";

function runnableExtract(_archivePath: string, destination: string): void {
  const launcher = join(destination, "services/host-daemon/bin");
  mkdirSync(launcher, { recursive: true });
  writeFileSync(join(destination, "package.json"), "{}\n");
  writeFileSync(join(launcher, "auto-harness-host-daemon.mjs"), "// launcher\n");
}

function updateRoot(): { rootDir: string; cleanup: () => void } {
  const rootDir = mkdtempSync(join(tmpdir(), "ah-update-start-"));
  return { rootDir, cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

/**
 * The file installer owns these test roots, unlike Linux production roots
 * where systemd's root-owned helper owns promotion and rollback. Model a
 * healthy launchd restart so these tests exercise mutable-root recovery
 * without invoking the host's service manager.
 */
function mutableRootService(rootDir: string, restartSucceeds = true) {
  let inspection = 0;
  return {
    env: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
    log: () => undefined,
    error: () => undefined,
    platform: "darwin",
    run: (_command: string, args: string[]) => {
      if (args[0] === "print") {
        inspection += 1;
        return { status: 0, stdout: `state = running\npid = ${inspection}\n`, stderr: "" };
      }
      if (args[0] === "kickstart" && !restartSucceeds) {
        return { status: 1, stdout: "", stderr: "restart failed" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

describe("startDaemon", () => {
  it("queues the Linux supervisor handoff without invoking systemctl", async () => {
    const signals: Array<[number, NodeJS.Signals]> = [];
    requestSupervisorRestart((pid, signal) => signals.push([pid, signal]));
    expect(signals).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(signals).toEqual([[process.pid, "SIGTERM"]]);
  });

  it("rolls back a second unacknowledged mutable-root boot before daemon preflight", async () => {
    const { rootDir, cleanup } = updateRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);
      await installer.stage({ version: "1.1.0", artifact: new Uint8Array() });
      await installer.activate("1.1.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");

      await expect(
        prepareDaemonUpdateBoot({
          env: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
          log: () => undefined,
          error: () => undefined,
          service: mutableRootService(rootDir),
        }),
      ).rejects.toThrow("rolled back unacknowledged update boot");
      expect(readInstalledVersion(rootDir)).toBe("1.0.0");
    } finally {
      cleanup();
    }
  });

  it("settles a crashing mutable-root replacement before the stable launcher selects it", async () => {
    const { rootDir, cleanup } = updateRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);
      await installer.stage({ version: "1.1.0", artifact: new Uint8Array() });
      await installer.activate("1.1.0");

      // This is called by the stable launchd/schtasks wrapper, not by 1.1.0.
      // It still executes when loading that activated module crashes pre-main.
      await expect(
        prepareStableDaemonUpdateBoot({
          env: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
          platform: "darwin",
        }),
      ).resolves.toBe("booting");
      await expect(
        prepareStableDaemonUpdateBoot({
          env: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
          platform: "darwin",
        }),
      ).resolves.toBe("rolled-back");
      expect(readInstalledVersion(rootDir)).toBe("1.0.0");
    } finally {
      cleanup();
    }
  });

  it("leaves Linux boot fencing to the root-owned systemd helper", async () => {
    await expect(
      prepareStableDaemonUpdateBoot({
        env: { HARNESS_UPDATE_INSTALL_DIR: "/not-used-by-the-linux-launcher" },
        platform: "linux",
      }),
    ).resolves.toBe("none");
  });

  it("resolves non-Linux default roots without selecting an activated module", async () => {
    const { rootDir, cleanup } = updateRoot();
    try {
      await expect(
        prepareStableDaemonUpdateBoot({ env: {}, platform: "darwin", home: rootDir }),
      ).resolves.toBe("none");
      await expect(
        prepareStableDaemonUpdateBoot({ env: {}, platform: "win32", appData: rootDir }),
      ).resolves.toBe("none");
      await expect(
        prepareStableDaemonUpdateBoot({ env: { HARNESS_UPDATE_INSTALL_DIR: rootDir } }),
      ).resolves.toBe("none");
    } finally {
      cleanup();
    }
  });

  it("fails closed when a mutable-root rollback cannot request its supervisor handoff", async () => {
    const { rootDir, cleanup } = updateRoot();
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");

      await expect(
        prepareDaemonUpdateBoot({
          env: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
          log: () => undefined,
          error: () => undefined,
          service: mutableRootService(rootDir, false),
        }),
      ).rejects.toThrow("could not restart the supervisor");
      expect(readInstalledVersion(rootDir)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("acknowledges a replacement only after its registration barrier opens", async () => {
    const { rootDir, cleanup: cleanupUpdate } = updateRoot();
    const { config, cleanup } = await makeRepo();
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; hostId?: string };
        if (message.type === "host:register") {
          socket.send(JSON.stringify({ type: "host:registered", hostId: message.hostId }));
        }
        if (message.type === "host:status") {
          socket.send(JSON.stringify({ type: "host:draining", hostId: message.hostId }));
        }
      });
    });
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      await listen(server);
      const lines: string[] = [];
      const daemon = await startDaemon({
        config,
        wsUrl: `ws://127.0.0.1:${port(server)}/ws`,
        childEnvSource: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
        updateBootPrepared: true,
        updateService: mutableRootService(rootDir),
        inventoryPollMs: 0,
        log: (line) => lines.push(line),
      });
      expect(lines).toContain("updater replacement health acknowledged");
      expect(confirmPendingUpdateBoot(rootDir)).toBe(false);
      await daemon.stop();
    } finally {
      await close(wss, server);
      cleanup();
      cleanupUpdate();
    }
  });

  it("fails closed if registration reaches an unattempted update marker", async () => {
    const { rootDir, cleanup: cleanupUpdate } = updateRoot();
    const { config, cleanup } = await makeRepo();
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; hostId?: string };
        if (message.type === "host:register") {
          socket.send(JSON.stringify({ type: "host:registered", hostId: message.hostId }));
        }
      });
    });
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await listen(server);

      await expect(
        startDaemon({
          config,
          wsUrl: `ws://127.0.0.1:${port(server)}/ws`,
          childEnvSource: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
          updateBootPrepared: true,
          updateService: mutableRootService(rootDir),
          inventoryPollMs: 0,
          log: () => undefined,
          error: () => undefined,
        }),
      ).rejects.toThrow("pending update boot was not attempted");

      // The failure path consumes the boot attempt instead of letting an
      // invalid marker survive indefinitely; a successful later registration
      // may acknowledge it.
      expect(confirmPendingUpdateBoot(rootDir)).toBe(true);
    } finally {
      await close(wss, server);
      cleanup();
      cleanupUpdate();
    }
  });

  it("rolls back and reports a broken acknowledgement before the daemon can continue", async () => {
    const { rootDir, cleanup: cleanupUpdate } = updateRoot();
    const { config, cleanup } = await makeRepo();
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; hostId?: string };
        if (message.type === "host:register") {
          // Simulate a release that becomes unreadable between first-boot
          // preparation and its registration acknowledgement.
          rmSync(join(rootDir, "current"), { recursive: true, force: true });
          socket.send(JSON.stringify({ type: "host:registered", hostId: message.hostId }));
        }
      });
    });
    try {
      const installer = createFileUpdateInstaller({ rootDir, extract: runnableExtract });
      await installer.stage({ version: "1.0.0", artifact: new Uint8Array() });
      await installer.activate("1.0.0");
      await expect(recoverPendingUpdateBoot({ rootDir })).resolves.toBe("booting");
      await listen(server);

      await expect(
        startDaemon({
          config,
          wsUrl: `ws://127.0.0.1:${port(server)}/ws`,
          childEnvSource: { HARNESS_UPDATE_INSTALL_DIR: rootDir },
          updateBootPrepared: true,
          updateService: mutableRootService(rootDir),
          inventoryPollMs: 0,
          log: () => undefined,
          error: () => undefined,
        }),
      ).rejects.toThrow("updater health acknowledgement failed");
      expect(readInstalledVersion(rootDir)).toBeUndefined();
    } finally {
      await close(wss, server);
      cleanup();
      cleanupUpdate();
    }
  });

  it("times out a server that never opens the registration barrier", async () => {
    const { config, cleanup } = await makeRepo();
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (socket) => {
      socket.on("message", () => {
        // Keep the registration barrier closed.
      });
    });
    try {
      await listen(server);
      await expect(
        startDaemon({
          config,
          wsUrl: `ws://127.0.0.1:${port(server)}/ws`,
          registrationTimeoutMs: 10,
        }),
      ).rejects.toThrow("timed out waiting for WebSocket registration");
    } finally {
      await close(wss, server);
      cleanup();
    }
  });

  it("loads execution profiles before opening the WebSocket", async () => {
    const { config, cleanup } = await makeRepo();
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    let connections = 0;
    wss.on("connection", () => {
      connections += 1;
    });
    try {
      await listen(server);
      await expect(
        startDaemon({
          config,
          wsUrl: `ws://127.0.0.1:${port(server)}/ws`,
          childEnvSource: { HARNESS_EXECUTION_PROFILES: "/no/such/profiles.json" },
        }),
      ).rejects.toThrow(/ENOENT|no such file/i);
      expect(connections).toBe(0);
    } finally {
      await close(wss, server);
      cleanup();
    }
  });

  it("commits a drain notification before closing the daemon connection", async () => {
    const { config, cleanup } = await makeRepo();
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    const received: string[] = [];
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; hostId?: string };
        received.push(message.type);
        if (message.type === "host:register") {
          socket.send(JSON.stringify({ type: "host:registered", hostId: config.hostId }));
        }
        if (message.type === "host:status") {
          socket.send(JSON.stringify({ type: "host:draining", hostId: message.hostId }));
        }
      });
    });
    try {
      await listen(server);
      const errors: string[] = [];
      const daemon = await startDaemon({
        config,
        wsUrl: `ws://127.0.0.1:${port(server)}/ws`,
        inventoryPollMs: 0,
        error: (line) => errors.push(line),
        childEnvSource: { HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.test/m.json" },
      });
      await daemon.stop();
      expect(received).toEqual(["host:register", "host:status"]);
      expect(errors.some((line) => line.includes("updater disabled"))).toBe(true);
    } finally {
      await close(wss, server);
      cleanup();
    }
  });
});

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
}

function port(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function close(wss: WebSocketServer, server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
