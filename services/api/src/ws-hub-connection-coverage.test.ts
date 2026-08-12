import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { HostToServerMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { attachHostWsHub, createPlaneWsBridge, type WsHub } from "./ws-hub.ts";

describe("WebSocket hub connection guards", () => {
  it("attaches through the public helper and rejects non-WebSocket paths", async () => {
    const plane = new ControlPlane();
    const harness = await startHarness(plane, true);
    try {
      await expectClosed(`${harness.origin}/not-ws`);
      const socket = await open(`${harness.origin}/ws`);
      socket.send(JSON.stringify(register("host-1")));
      await waitForMessage(socket, "host:registered");
      expect(harness.hub.hostCount()).toBe(1);
      socket.close();
      await waitForClose(socket);
    } finally {
      await harness.close();
    }
  });

  it("rejects invalid, pre-registration, and rebound-host messages", async () => {
    const harness = await startHarness(new ControlPlane());
    try {
      const invalid = await open(`${harness.origin}/ws`);
      invalid.send("{");
      expect(await waitForClose(invalid)).toBe(1008);

      const unbound = await open(`${harness.origin}/ws`);
      unbound.send(JSON.stringify(keepalive("host-1")));
      unbound.send(JSON.stringify(keepalive("host-1")));
      expect(await waitForClose(unbound)).toBe(1008);

      const rebound = await open(`${harness.origin}/ws`);
      rebound.send(JSON.stringify(register("host-1")));
      await waitForMessage(rebound, "host:registered");
      rebound.send(JSON.stringify(register("host-2")));
      expect(await waitForClose(rebound)).toBe(1008);
    } finally {
      await harness.close();
    }
  });

  it("expires the rate window and then enforces its message cap", async () => {
    const rateEvents: Array<{ limit: number }> = [];
    const harness = await startHarness(new ControlPlane(), false, 1, rateEvents);
    try {
      const socket = await open(`${harness.origin}/ws`);
      socket.send(JSON.stringify(register("host-rate")));
      await waitForMessage(socket, "host:registered");
      await new Promise((resolve) => setTimeout(resolve, 1_010));
      for (let index = 0; index < 5; index++) {
        socket.send(JSON.stringify(keepalive("host-rate")));
      }
      expect(await waitForClose(socket)).toBe(1008);
      expect(rateEvents).toContainEqual(expect.objectContaining({ limit: 1 }));
    } finally {
      await harness.close();
    }

    const defaultRateEvents: Array<{ limit: number }> = [];
    const defaultHarness = await startHarness(
      new ControlPlane(),
      false,
      undefined,
      defaultRateEvents,
    );
    try {
      const socket = await open(`${defaultHarness.origin}/ws`);
      socket.send(JSON.stringify(register("host-default-rate")));
      await waitForMessage(socket, "host:registered");
      for (let index = 0; index < 102; index++) {
        socket.send(JSON.stringify(keepalive("host-default-rate")));
      }
      expect(await waitForClose(socket)).toBe(1008);
      expect(defaultRateEvents).toContainEqual(expect.objectContaining({ limit: 100 }));
    } finally {
      await defaultHarness.close();
    }
  });

  it("fences a socket whose durable host lease was replaced", async () => {
    const plane = new ControlPlane();
    const harness = await startHarness(plane);
    try {
      const socket = await open(`${harness.origin}/ws`);
      socket.send(JSON.stringify(register("host-stale")));
      await waitForMessage(socket, "host:registered");
      await plane.registerHostDurable({ ...register("host-stale"), replaceExisting: true });
      socket.send(JSON.stringify(keepalive("host-stale")));
      expect(await waitForClose(socket)).toBe(1008);
    } finally {
      await harness.close();
    }
  });

  it("serializes durable failures into error frames and closes thrown handlers", async () => {
    const collision = new ControlPlane();
    collision.registerHost({
      hostId: "owner",
      worktrees: [{ id: "shared", name: "shared", repositoryId: "repo", path: "/a", labels: [] }],
      commandProfiles: [],
    });
    const collisionHarness = await startHarness(collision);
    try {
      const socket = await open(`${collisionHarness.origin}/ws`);
      socket.send(JSON.stringify(register("challenger", "shared")));
      expect(await waitForMessage(socket, "error")).toMatchObject({ type: "error" });
      socket.close();
      await waitForClose(socket);
    } finally {
      await collisionHarness.close();
    }

    const throwingHarness = await startHarness(new ThrowingPlane());
    try {
      const socket = await open(`${throwingHarness.origin}/ws`);
      socket.send(JSON.stringify(register("host-throw")));
      expect(await waitForClose(socket)).toBe(1011);
    } finally {
      await throwingHarness.close();
    }
  });
});

class ThrowingPlane extends ControlPlane {
  override async handleHostMessageDurable(_message: HostToServerMessage) {
    throw new Error("durable boundary failed");
  }
}

function register(hostId: string, worktreeId?: string) {
  return {
    type: "host:register" as const,
    hostId,
    worktrees: worktreeId
      ? [{ id: worktreeId, name: worktreeId, repositoryId: "repo", path: "/worktree", labels: [] }]
      : [],
    commandProfiles: [],
  };
}

function keepalive(hostId: string) {
  return { type: "host:keepalive" as const, hostId, at: new Date().toISOString() };
}

async function startHarness(
  plane: ControlPlane,
  usePublicAttach = false,
  maxMessagesPerSecond?: number,
  rateEvents?: Array<{ limit: number }>,
): Promise<{
  origin: string;
  hub: WsHub;
  close(): Promise<void>;
}> {
  const server = createServer();
  const hub = usePublicAttach
    ? attachHostWsHub(server, plane)
    : createPlaneWsBridge({
        ...(maxMessagesPerSecond === undefined ? {} : { maxMessagesPerSecond }),
        ...(rateEvents
          ? { onRateLimitEvent: (event) => rateEvents.push({ limit: event.limit }) }
          : {}),
      }).attach(server, plane);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    origin: `ws://127.0.0.1:${address.port}`,
    hub,
    async close() {
      hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function open(url: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitForMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === type) resolve(message);
    });
    socket.once("error", reject);
  });
}

async function waitForClose(socket: WebSocket): Promise<number> {
  if (socket.readyState === WebSocket.CLOSED) return 1006;
  return await new Promise((resolve) => socket.once("close", (code) => resolve(code)));
}

async function expectClosed(url: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = new WebSocket(url);
    socket.once("error", () => resolve());
    socket.once("close", () => resolve());
  });
}
