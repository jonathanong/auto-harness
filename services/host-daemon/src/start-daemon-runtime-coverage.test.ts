/* eslint-disable max-lines -- startup runtime coverage shares one daemon harness. */
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(() => ({ status: 0, stderr: "" })) };
});

import { emptyDaemonConfig } from "./bootstrap.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";
import { startDaemon } from "./start-daemon.ts";
import * as updaterRuntime from "./agent-updater-runtime.ts";

afterEach(() => vi.useRealTimers());

describe("startDaemon runtime wiring", () => {
  it("requires a configured WebSocket target", async () => {
    const config = emptyDaemonConfig({ hostId: "host-1", apiUrl: "" });
    await expect(startDaemon({ config })).rejects.toThrow("apiUrl (or --ws) is required");
  });

  it("normalizes an HTTP origin, registers empty inventory, and stops after runUntil", async () => {
    const harness = await acceptingServer();
    const lines: string[] = [];
    const config = emptyDaemonConfig({
      hostId: "host-empty",
      apiUrl: `http://127.0.0.1:${harness.port}/`,
    });
    try {
      const daemon = await startDaemon({
        config,
        runUntil: Promise.resolve(),
        log: (line) => lines.push(line),
      });
      expect(lines).toContain(`connected and registered ws://127.0.0.1:${harness.port}/ws`);
      expect(
        lines.some((line) =>
          line.includes("attach repositories from the control plane Hosts page"),
        ),
      ).toBe(true);
      expect(lines.some((line) => line.includes("host pane"))).toBe(false);
      expect(daemon.loop.inflightCount()).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("polls changed inventory, applies it, and re-registers", async () => {
    const harness = await acceptingServer();
    const { config, cleanup } = await makeRepo();
    const lines: string[] = [];
    let fetches = 0;
    try {
      await startDaemon({
        config: { ...config, apiUrl: `ws://127.0.0.1:${harness.port}/ws` },
        identity: {
          hostId: config.hostId,
          apiUrl: `http://127.0.0.1:${harness.port}`,
        },
        inventoryPollMs: 5,
        runUntil: waitFor(() => harness.registrations >= 2),
        fetchFn: async () => {
          fetches++;
          return Response.json({
            repositories: config.repositories.map((repo) => ({
              ...repo,
              defaultBranch: "refreshed",
            })),
          });
        },
        log: (line) => lines.push(line),
      });
      expect(fetches).toBeGreaterThan(0);
      expect(harness.registrations).toBeGreaterThanOrEqual(2);
      expect(lines.some((line) => line.includes("host inventory updated"))).toBe(true);
      expect(lines.some((line) => line.includes("(1 repo(s))"))).toBe(true);
    } finally {
      cleanup();
      await harness.close();
    }
  });

  it("reports WSS connection errors while enforcing the registration deadline", async () => {
    const errors: string[] = [];
    const config = emptyDaemonConfig({ hostId: "host-1", apiUrl: "" });
    await expect(
      startDaemon({
        config,
        wsUrl: "https://127.0.0.1:1",
        registrationTimeoutMs: 20,
        error: (line) => errors.push(line),
      }),
    ).rejects.toThrow("timed out waiting for WebSocket registration at wss://127.0.0.1:1/ws");
    expect(errors.some((line) => line.startsWith("ws error:"))).toBe(true);
  });

  it("reports Error and primitive keepalive failures", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const harness = await acceptingServer();
    const errors: string[] = [];
    const config = emptyDaemonConfig({
      hostId: "host-keepalive",
      apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
    });
    const daemon = await startDaemon({ config, error: (line) => errors.push(line) });
    try {
      const internals = daemon.loop as unknown as {
        transport: { close(): void };
        keepalive(): Promise<void>;
      };
      internals.transport.close();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(errors).toContain("keepalive failed: WebSocket transport closed");
      internals.keepalive = async () => {
        throw "primitive keepalive";
      };
      await vi.advanceTimersByTimeAsync(20_000);
      expect(errors).toContain("keepalive failed: primitive keepalive");
    } finally {
      // This case deliberately closes the transport before exercising the
      // keepalive timer. A graceful drain requires a live transport, so use
      // the loop's direct shutdown path for cleanup.
      daemon.loop.stop();
      await harness.close();
    }
  });

  it("emits a periodic liveness log line reflecting live transport state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const harness = await acceptingServer();
    const lines: string[] = [];
    const config = emptyDaemonConfig({
      hostId: "host-liveness",
      apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
    });
    const daemon = await startDaemon({ config, log: (line) => lines.push(line) });
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      const liveness = lines.filter((line) => line.startsWith("daemon liveness:"));
      expect(liveness).toHaveLength(1);
      expect(liveness[0]).toContain("registered=true");
      expect(liveness[0]).toContain("queued=0");
    } finally {
      daemon.loop.stop();
      await harness.close();
    }
  });

  it("records a successful keepalive send timestamp", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const keepalive = vi.spyOn(DaemonLoop.prototype, "keepalive").mockResolvedValue(true);
    const harness = await acceptingServer();
    const lines: string[] = [];
    const config = emptyDaemonConfig({
      hostId: "host-keepalive-sent",
      apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
    });
    const daemon = await startDaemon({ config, log: (line) => lines.push(line) });
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(keepalive).toHaveBeenCalled();
      expect(
        lines.some(
          (line) =>
            line.startsWith("daemon liveness:") &&
            line.includes("last keepalive sent=") &&
            !line.includes("none yet"),
        ),
      ).toBe(true);
    } finally {
      keepalive.mockRestore();
      daemon.loop.stop();
      await harness.close();
    }
  });

  it("keeps the legacy install root when host update config moves its staging root", async () => {
    const harness = await acceptingServer();
    const { config, cleanup } = await makeRepo();
    const errors: string[] = [];
    vi.stubGlobal("fetch", async () => new Response("temporarily unavailable", { status: 503 }));
    try {
      await startDaemon({
        config: {
          ...config,
          apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
          updateConfig: {
            enabled: true,
            manifestUrl: "https://updates.example.test/manifest.json",
            publicKey: "public key",
            installDir: "/configured-root",
            pollMs: 0,
          },
        },
        childEnvSource: { HARNESS_UPDATE_INSTALL_DIR: "/legacy-root" },
        updateService: {
          env: { HARNESS_UPDATE_INSTALL_DIR: "/legacy-root" },
          platform: "linux",
          log: () => undefined,
          error: () => undefined,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        },
        fetchFn: async () => new Response("temporarily unavailable", { status: 503 }),
        error: (line) => errors.push(line),
        runUntil: Promise.resolve(),
      });
      expect(errors).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      cleanup();
      await harness.close();
    }
  });

  it("disables an updater whose legacy service environment is incomplete", async () => {
    const harness = await acceptingServer();
    const { config, cleanup } = await makeRepo();
    const errors: string[] = [];
    try {
      const daemon = await startDaemon({
        config: { ...config, apiUrl: `ws://127.0.0.1:${harness.port}/ws` },
        childEnvSource: {
          HARNESS_UPDATE_MANIFEST_URL: "https://updates.example.test/manifest.json",
        },
        error: (line) => errors.push(line),
        runUntil: Promise.resolve(),
      });
      expect(errors).toContain(
        "updater disabled: HARNESS_UPDATE_MANIFEST_URL and HARNESS_UPDATE_PUBLIC_KEY are both required",
      );
      await daemon.stop();
    } finally {
      cleanup();
      await harness.close();
    }
  });

  it("selects the Windows restart handoff from process.platform", async () => {
    const harness = await acceptingServer();
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const daemon = await startDaemon({
        config: emptyDaemonConfig({
          hostId: "host-win32",
          apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
        }),
        runUntil: Promise.resolve(),
      });
      expect(daemon.loop.inflightCount()).toBe(0);
    } finally {
      if (descriptor) Object.defineProperty(process, "platform", descriptor);
      await harness.close();
    }
  });

  it("acknowledges systemd registration readiness on a privileged Linux service", async () => {
    const harness = await acceptingServer();
    const lines: string[] = [];
    vi.mocked(spawnSync).mockReturnValueOnce({ status: 0, stderr: "" } as never);
    try {
      await startDaemon({
        config: emptyDaemonConfig({
          hostId: "host-systemd",
          apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
        }),
        childEnvSource: { NOTIFY_SOCKET: "/run/systemd/notify" },
        updateService: {
          env: { NOTIFY_SOCKET: "/run/systemd/notify" },
          platform: "linux",
          log: () => undefined,
          error: () => undefined,
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        },
        log: (line) => lines.push(line),
        runUntil: Promise.resolve(),
      });
      expect(lines).toContain("systemd registration readiness acknowledged");
    } finally {
      await harness.close();
    }
  });

  it("stringifies primitive updater health and rollback failures", async () => {
    const harness = await acceptingServer();
    const notify = vi.spyOn(updaterRuntime, "notifySystemdReady").mockImplementation(() => {
      throw "ack-offline";
    });
    const recover = vi
      .spyOn(updaterRuntime, "recoverDaemonUpdateBoot")
      .mockRejectedValue("rollback-offline");
    try {
      await expect(
        startDaemon({
          config: emptyDaemonConfig({
            hostId: "host-ack-string",
            apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
          }),
          updateBootPrepared: true,
        }),
      ).rejects.toThrow("updater health acknowledgement failed: ack-offline; rollback-offline");
    } finally {
      notify.mockRestore();
      recover.mockRestore();
      await harness.close();
    }
  });

  it("stringifies a primitive updater construction failure", async () => {
    const harness = await acceptingServer();
    const errors: string[] = [];
    const create = vi.spyOn(updaterRuntime, "createDaemonUpdater").mockImplementation(() => {
      throw "updater-offline";
    });
    try {
      const daemon = await startDaemon({
        config: emptyDaemonConfig({
          hostId: "host-updater-string",
          apiUrl: `ws://127.0.0.1:${harness.port}/ws`,
        }),
        error: (line) => errors.push(line),
        runUntil: Promise.resolve(),
      });
      expect(errors).toContain("updater disabled: updater-offline");
      await daemon.stop();
    } finally {
      create.mockRestore();
      await harness.close();
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function acceptingServer(): Promise<{
  port: number;
  registrations: number;
  close(): Promise<void>;
}> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws" });
  const state = { registrations: 0 };
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string; hostId?: string };
      if (message.type === "host:register") {
        state.registrations++;
        socket.send(JSON.stringify({ type: "host:registered", hostId: message.hostId }));
      } else if (message.type === "host:status") {
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
    get registrations() {
      return state.registrations;
    },
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
