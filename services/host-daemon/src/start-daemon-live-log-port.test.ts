import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

import { makeRepo } from "../test-helpers/daemon-loop-test-helpers.ts";
import { startDaemon } from "./start-daemon.ts";

describe("startDaemon live log port", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("skips the loopback live-log server when the port is off", async () => {
    vi.stubEnv("HARNESS_DAEMON_LIVE_LOG_PORT", "off");
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
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.on("error", reject);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no port");
      const daemon = await startDaemon({
        config,
        wsUrl: `ws://127.0.0.1:${String(address.port)}/ws`,
        inventoryPollMs: 0,
      });
      await daemon.stop();
      expect(true).toBe(true);
    } finally {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      cleanup();
    }
  });
});
