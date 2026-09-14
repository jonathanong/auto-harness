import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("ws-hub pending host socket publish", () => {
  it("marks an in-flight register and clears it after host:registered", async () => {
    const run = await startPendingRegister();
    try {
      const socket = await openSocket(run.origin);
      socket.send(JSON.stringify(hostRegistration()));
      await waitUntil(() => run.plane.state.pendingHostSocketPublish.has("pending-conn"));
      run.release();
      await waitForType(socket, "host:registered");
      expect(run.plane.state.pendingHostSocketPublish.has("pending-conn")).toBe(false);
      socket.close();
      await waitForClose(socket);
    } finally {
      await run.close();
    }
  });

  it("clears the in-flight mark when register fails or the socket closes", async () => {
    const failed = await startPendingRegister({ failRegister: true });
    try {
      const socket = await openSocket(failed.origin);
      socket.send(JSON.stringify(hostRegistration()));
      await waitUntil(() => failed.plane.state.pendingHostSocketPublish.has("pending-conn"));
      failed.release();
      await waitForType(socket, "error");
      expect(failed.plane.state.pendingHostSocketPublish.has("pending-conn")).toBe(false);
      socket.close();
      await waitForClose(socket);
    } finally {
      await failed.close();
    }

    const closed = await startPendingRegister();
    try {
      const socket = await openSocket(closed.origin);
      socket.send(JSON.stringify(hostRegistration()));
      await waitUntil(() => closed.plane.state.pendingHostSocketPublish.has("pending-conn"));
      socket.close();
      await waitForClose(socket);
      await waitUntil(() => !closed.plane.state.pendingHostSocketPublish.has("pending-conn"));
    } finally {
      await closed.close();
    }
  });
});

async function startPendingRegister(options: { failRegister?: boolean } = {}) {
  const bridge = createPlaneWsBridge();
  const plane = new ControlPlane({ connectionIdFactory: () => "pending-conn" });
  let releaseGate: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const original = plane.handleHostMessageDurable.bind(plane);
  plane.handleHostMessageDurable = async (msg, connectionId, replaceExisting, protocol) => {
    if (msg.type === "host:register") await gate;
    if (options.failRegister && msg.type === "host:register") {
      return { ok: false, error: "rejected" };
    }
    return original(msg, connectionId, replaceExisting, protocol);
  };
  const server = createServer();
  const hub = bridge.attach(server, plane);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    plane,
    origin: `ws://127.0.0.1:${address.port}`,
    release() {
      releaseGate();
    },
    async close() {
      releaseGate();
      hub.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function hostRegistration() {
  return {
    type: "host:register",
    hostId: "host",
    protocolVersion: HOST_PROTOCOL_VERSION,
    worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
    commandProfiles: [],
    runtime: { daemonVersion: "1.0.0", gitVersion: "2.36.0", gitReady: true },
  };
}

async function openSocket(origin: string): Promise<WebSocket> {
  const socket = new WebSocket(`${origin}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

async function waitForType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${type} timeout`)), 3000);
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}
