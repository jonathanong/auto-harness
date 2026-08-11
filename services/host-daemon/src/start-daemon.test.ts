import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { makeRepo } from "./daemon-loop-test-helpers.ts";
import { startDaemon } from "./start-daemon.ts";

describe("startDaemon", () => {
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
      const daemon = await startDaemon({
        config,
        wsUrl: `ws://127.0.0.1:${port(server)}/ws`,
        inventoryPollMs: 0,
      });
      await daemon.stop();
      expect(received).toEqual(["host:register", "host:status"]);
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
