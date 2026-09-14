import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";
import { HostInventoryPolicyError } from "./bootstrap.ts";
import * as liveLogHttp from "./live-log-http.ts";
import { startDaemon } from "./start-daemon.ts";

describe("startDaemon live log port", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("skips the loopback live-log server when the port is off", async () => {
    vi.stubEnv("HARNESS_DAEMON_LIVE_LOG_PORT", "off");
    await withAcceptingServer(async (wsUrl) => {
      const { config, cleanup } = await makeRepo();
      try {
        const daemon = await startDaemon({
          config,
          wsUrl,
          inventoryPollMs: 0,
        });
        await daemon.stop();
      } finally {
        cleanup();
      }
    });
  });

  it("wires loopback live-log subscribe through the daemon loop", async () => {
    vi.stubEnv("HARNESS_DAEMON_LIVE_LOG_PORT", "7501");
    const subscribed: string[] = [];
    const start = vi.spyOn(liveLogHttp, "startLiveLogHttp").mockImplementation((options) => {
      const unsubscribe = options.subscribe("sess-1", () => undefined);
      subscribed.push("sess-1");
      unsubscribe();
      return { close: async () => undefined, server: createServer() };
    });
    await withAcceptingServer(async (wsUrl) => {
      const { config, cleanup } = await makeRepo();
      try {
        await startDaemon({
          config,
          wsUrl,
          inventoryPollMs: 0,
          runUntil: Promise.resolve(),
        });
        expect(start).toHaveBeenCalledOnce();
        expect(subscribed).toEqual(["sess-1"]);
      } finally {
        start.mockRestore();
        cleanup();
      }
    });
  });

  it("blocks assignments when an inventory poll hits a root policy error", async () => {
    vi.stubEnv("HARNESS_DAEMON_LIVE_LOG_PORT", "off");
    await withAcceptingServer(async (wsUrl, port) => {
      const { config, cleanup } = await makeRepo();
      const errors: string[] = [];
      try {
        await startDaemon({
          config,
          wsUrl,
          identity: {
            hostId: config.hostId,
            apiUrl: `http://127.0.0.1:${String(port)}`,
          },
          inventoryPollMs: 20,
          fetchFn: async () => {
            throw new HostInventoryPolicyError(new Error("outside root"), ["/safe/root"]);
          },
          error: (line) => errors.push(line),
          runUntil: waitFor(() => errors.some((line) => line.includes("inventory poll failed"))),
        });
        expect(errors.some((line) => line.includes("inventory poll failed"))).toBe(true);
      } finally {
        cleanup();
      }
    });
  });
});

async function withAcceptingServer(
  run: (wsUrl: string, port: number) => Promise<void>,
): Promise<void> {
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
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", resolve);
      server.on("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    await run(`ws://127.0.0.1:${String(address.port)}/ws`, address.port);
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for daemon condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
