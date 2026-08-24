import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import type { HostToServerMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("WebSocket durable ACK replies", () => {
  it("replies after a durable acknowledgement commits", async () => {
    const run = await startHarness(new AckPlane());
    try {
      const socket = await registered(run.origin);
      socket.send(JSON.stringify(ack()));
      await expect(waitForMessage(socket)).resolves.toEqual({
        type: "session:acknowledged",
        sessionId: "ack-session",
        attemptId: "attempt-1",
      });
      socket.close();
      await waitForClose(socket);
    } finally {
      await run.close();
    }
  });

  it("does not reply when the socket closes during the durable commit", async () => {
    const plane = new AckPlane(true);
    const run = await startHarness(plane);
    try {
      const socket = await registered(run.origin);
      socket.send(JSON.stringify(ack()));
      await plane.started;
      socket.close();
      await waitForClose(socket);
      plane.release();
      await Promise.resolve();
    } finally {
      plane.release();
      await run.close();
    }
  });
});

class AckPlane extends ControlPlane {
  private releaseAck: (() => void) | undefined;
  private readonly gate: Promise<void> | undefined;
  private readonly markStarted: () => void;
  readonly started: Promise<void>;

  constructor(block = false) {
    super();
    this.started = new Promise((resolve) => (this.markStarted = resolve));
    this.gate = block ? new Promise((resolve) => (this.releaseAck = resolve)) : undefined;
  }

  release(): void {
    this.releaseAck?.();
  }

  override getSession(id: string): ReturnType<ControlPlane["getSession"]> {
    return id === "ack-session"
      ? ({ hostId: "ack-host" } as ReturnType<ControlPlane["getSession"]>)
      : null;
  }

  override async handleHostMessageDurable(message: HostToServerMessage) {
    if (message.type === "session:ack") {
      this.markStarted();
      await this.gate;
      return { ok: true, sessionAcknowledged: message.sessionId };
    }
    return super.handleHostMessageDurable(message);
  }
}

function ack() {
  return {
    type: "session:ack" as const,
    sessionId: "ack-session",
    worktreeId: null,
    attemptId: "attempt-1",
  };
}

async function startHarness(plane: ControlPlane) {
  const server = createServer();
  const hub = createPlaneWsBridge().attach(server, plane);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    origin: `ws://127.0.0.1:${address.port}`,
    async close() {
      hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function registered(origin: string): Promise<WebSocket> {
  const socket = new WebSocket(`${origin}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(
    JSON.stringify({
      type: "host:register",
      hostId: "ack-host",
      worktrees: [],
      commandProfiles: [],
    }),
  );
  await waitForMessage(socket);
  return socket;
}

async function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(String(raw)) as Record<string, unknown>));
    socket.once("error", reject);
  });
}

async function waitForClose(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
