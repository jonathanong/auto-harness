import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { emptyDaemonConfig } from "./bootstrap.ts";
import { makeRepo } from "./daemon-loop-test-helpers.ts";
import { startDaemon } from "./start-daemon.ts";

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
