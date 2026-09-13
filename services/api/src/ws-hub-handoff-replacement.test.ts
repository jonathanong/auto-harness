import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("local replacement registration handoff delivery", () => {
  it("delivers an outstanding handoff after host:registered on the new socket only", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({
      idFactory: () => "handoff",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.setOnHostMessage(bridge.onHostMessage);
    const run = await startHub(bridge, plane);
    try {
      const incumbent = await openSocket(run.origin);
      const incumbentMessages: Array<Record<string, unknown>> = [];
      incumbent.on("message", (raw) => {
        incumbentMessages.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });
      incumbent.send(JSON.stringify(hostRegistration()));
      await expect(waitForType(incumbent, "host:registered")).resolves.toMatchObject({
        type: "host:registered",
        hostId: "host",
      });
      seedOutstandingHandoff(plane);

      const replacement = await openSocket(run.origin);
      const replacementMessages: Array<Record<string, unknown>> = [];
      replacement.on("message", (raw) => {
        replacementMessages.push(JSON.parse(String(raw)) as Record<string, unknown>);
      });
      replacement.send(JSON.stringify(hostRegistration()));
      await waitForClose(incumbent);
      await waitUntil(
        () =>
          replacementMessages.some((message) => message.type === "host:registered") &&
          replacementMessages.some((message) => message.type === "session:terminal-hook"),
      );

      expect(replacementMessages.map((message) => message.type)).toEqual([
        "host:registered",
        "session:terminal-hook",
      ]);
      expect(replacementMessages[1]).toMatchObject({
        type: "session:terminal-hook",
        handoffId: "handoff",
        sessionId: "session",
      });
      expect(incumbentMessages.map((message) => message.type)).toEqual(["host:registered"]);
      replacement.close();
      await waitForClose(replacement);
    } finally {
      await run.close();
    }
  });
});

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

function seedOutstandingHandoff(plane: ControlPlane): void {
  plane.state.sessions.set("session", {
    id: "session",
    repositoryId: "r1",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "failed",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    hostId: "host",
    worktreeId: null,
    attemptId: "attempt",
    activeHostId: "host",
    activeHostOrder: "2026-01-01T00:00:00.000Z#session",
    terminalHookHandoff: {
      handoffId: "handoff",
      hostId: "host",
      repositoryId: "r1",
      worktreeId: "wt-1",
      status: "failed",
      expiresAt: "2026-01-02T00:00:00.000Z",
    },
  } as never);
}

async function startHub(bridge: ReturnType<typeof createPlaneWsBridge>, plane: ControlPlane) {
  const server = createServer();
  const hub = bridge.attach(server, plane);
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
