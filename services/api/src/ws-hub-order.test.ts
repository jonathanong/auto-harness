/* eslint-disable max-lines -- registration race scenarios share one websocket harness. */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

async function registeredSocket(
  bridge: ReturnType<typeof createPlaneWsBridge>,
  plane: ControlPlane,
  hostId: string,
  protocolVersion?: number,
): Promise<{
  ws: WebSocket;
  hub: ReturnType<typeof bridge.attach>;
  server: ReturnType<typeof createServer>;
  origin: string;
}> {
  const server = createServer();
  const hub = bridge.attach(server, plane);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "host:register",
          hostId,
          protocolVersion: protocolVersion ?? 7,
          daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
          daemonStartedAt: "2026-08-11T00:00:00.000Z",
          runningAttempts: [],
          worktrees: [],
          commandProfiles: [],
          runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        }),
      ),
    );
    const onMessage = (raw: WebSocket.RawData) => {
      if (JSON.parse(String(raw)).type !== "host:registered") return;
      ws.off("message", onMessage);
      resolve();
    };
    ws.on("message", onMessage);
    ws.on("error", reject);
  });
  return { ws, hub, server, origin: `ws://127.0.0.1:${address.port}` };
}

async function closeHub(
  ws: WebSocket,
  hub: ReturnType<ReturnType<typeof createPlaneWsBridge>["attach"]>,
  server: ReturnType<typeof createServer>,
): Promise<void> {
  ws.close();
  hub.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe("createPlaneWsBridge message ordering", () => {
  it("fences a detached timeout's deferred terminal report to its original host", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const session = {
      id: "timed-out-session",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: [],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T01:00:00.000Z",
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "timed_out" as const,
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
      hostId: null,
      worktreeId: null,
      timedOutHostId: "timeout-host",
      attemptId: "attempt",
    };
    let durable = session;
    plane.state.sessions.set(session.id, session);
    const opened = await registeredSocket(bridge, plane, "timeout-host", 7);
    const stale = new WebSocket(`${opened.origin}/ws`);
    await new Promise<void>((resolve, reject) => {
      stale.once("open", resolve);
      stale.once("error", reject);
    });
    const registered = new Promise<void>((resolve) => {
      stale.on("message", (raw) => {
        if (JSON.parse(String(raw)).type === "host:registered") resolve();
      });
    });
    stale.send(
      JSON.stringify({
        type: "host:register",
        hostId: "different-host",
        protocolVersion: 7,
        daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
        daemonStartedAt: "2026-08-11T00:00:00.000Z",
        runningAttempts: [],
        worktrees: [],
        commandProfiles: [],
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      }),
    );
    await registered;
    const connectionId = plane.state.hostConnection.get("timeout-host")!;
    plane.state.storage = {
      getSession: async () => durable,
      getHostLock: async (hostId: string) => (hostId === "timeout-host" ? connectionId : null),
      deleteConnection: async () => undefined,
      finishSession: async (input: { terminalHookHandoff?: unknown }) => {
        durable = { ...durable, terminalHookHandoff: input.terminalHookHandoff } as typeof durable;
        return true;
      },
    } as never;
    try {
      const acknowledged = new Promise<Record<string, unknown>>((resolve) => {
        opened.ws.on("message", (raw) => resolve(JSON.parse(String(raw))));
      });
      opened.ws.send(
        JSON.stringify({
          type: "session:status",
          sessionId: session.id,
          worktreeId: null,
          attemptId: "attempt",
          status: "failed",
          errorCode: "checkout_fetch_failed",
          deferTerminalHookResult: true,
        }),
      );
      await expect(acknowledged).resolves.toMatchObject({
        type: "session:status-acknowledged",
        sessionId: session.id,
        attemptId: "attempt",
        terminalHookHandoffId: expect.any(String),
      });

      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        stale.once("close", (code, reason) => resolve({ code, reason: String(reason) }));
      });
      stale.send(
        JSON.stringify({
          type: "session:status",
          sessionId: session.id,
          worktreeId: null,
          attemptId: "attempt",
          status: "failed",
          errorCode: "checkout_fetch_failed",
          deferTerminalHookResult: true,
        }),
      );
      await expect(closed).resolves.toEqual({ code: 1008, reason: "message not authorized" });
    } finally {
      // The fixture only models the durable writes under test. Let the normal
      // in-memory disconnect path clean up the owner socket.
      plane.state.storage = undefined;
      await closeHub(opened.ws, opened.hub, opened.server);
    }
  });

  it("drains an incumbent control frame before replacing its host lease", async () => {
    // session:log is rejected outright by the control-plane WS (see
    // "fix: enforce control-plane websocket protocol shapes"); drainForReplacement
    // still guards any in-flight durable work, so exercise it with a slow
    // control frame (host:keepalive) instead of the removed log-batch path.
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage, shardCount: 1 });
    const opened = await registeredSocket(bridge, plane, "reconnect-host");
    const originalHandle = plane.handleHostMessageDurable.bind(plane);
    let releaseKeepalive: () => void;
    const keepaliveBlocked = new Promise<void>((resolve) => {
      releaseKeepalive = resolve;
    });
    let keepaliveStarted: () => void;
    const keepaliveStartedPromise = new Promise<void>((resolve) => {
      keepaliveStarted = resolve;
    });
    let replacementStarted: () => void;
    const replacementStartedPromise = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    plane.handleHostMessageDurable = async (message, ...args) => {
      if (message.type === "host:keepalive" && message.hostId === "reconnect-host") {
        keepaliveStarted();
        await keepaliveBlocked;
        return originalHandle(message, ...args);
      }
      if (message.type === "host:register") replacementStarted();
      return originalHandle(message, ...args);
    };

    opened.ws.send(
      JSON.stringify({
        type: "host:keepalive",
        hostId: "reconnect-host",
        at: "2026-01-01T00:00:00.000Z",
      }),
    );
    await keepaliveStartedPromise;

    const address = opened.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const replacement = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const replacementRegistered = new Promise<void>((resolve, reject) => {
      replacement.on("open", () =>
        replacement.send(
          JSON.stringify({
            type: "host:register",
            hostId: "reconnect-host",
            protocolVersion: 7,
            daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
            daemonStartedAt: "2026-08-11T00:00:00.000Z",
            runningAttempts: [],
            worktrees: [],
            commandProfiles: [],
            runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
          }),
        ),
      );
      replacement.on("message", (raw) => {
        if (JSON.parse(String(raw)).type === "host:registered") resolve();
      });
      replacement.on("error", reject);
    });
    const incumbentClosed = new Promise<{ code: number; reason: string }>((resolve) => {
      opened.ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }));
    });

    expect(
      await Promise.race([
        replacementStartedPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]),
    ).toBe(false);
    releaseKeepalive!();
    await replacementRegistered;
    await expect(incumbentClosed).resolves.toEqual({ code: 1008, reason: "host reconnected" });

    replacement.close();
    opened.hub.close();
    await new Promise<void>((resolve, reject) =>
      opened.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("processes messages after a durable registration in wire order", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage, shardCount: 1 });
    const originalHandle = plane.handleHostMessageDurable.bind(plane);
    let releaseRegistration: () => void;
    const registrationBlocked = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationStarted: () => void;
    const registrationStartedPromise = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    let keepaliveStarted: () => void;
    const keepaliveStartedPromise = new Promise<void>((resolve) => {
      keepaliveStarted = resolve;
    });
    plane.handleHostMessageDurable = async (message) => {
      if (message.type === "host:register") {
        registrationStarted();
        await registrationBlocked;
      }
      if (message.type === "host:keepalive") keepaliveStarted();
      return await originalHandle(message);
    };

    const server = createServer();
    const hub = bridge.attach(server, plane);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const registered = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "host:register",
            hostId: "ordered-host",
            protocolVersion: 7,
            daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
            daemonStartedAt: "2026-08-11T00:00:00.000Z",
            runningAttempts: [],
            worktrees: [],
            commandProfiles: [],
            runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
          }),
        );
        ws.send(
          JSON.stringify({
            type: "host:keepalive",
            hostId: "ordered-host",
            at: new Date().toISOString(),
          }),
        );
      });
      ws.on("message", (raw) => {
        if (JSON.parse(String(raw)).type === "host:registered") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
    });

    await registrationStartedPromise;
    expect(
      await Promise.race([
        keepaliveStartedPromise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]),
    ).toBe(false);
    releaseRegistration!();
    await registered;
    await keepaliveStartedPromise;

    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("releases a durable registration that finishes after the socket closes", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage, shardCount: 1 });
    const originalHandle = plane.handleHostMessageDurable.bind(plane);
    const originalDisconnect = plane.disconnectHostDurable.bind(plane);
    let releaseRegistration: () => void;
    const registrationBlocked = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    let registrationStarted: () => void;
    const registrationStartedPromise = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    let resolveDisconnected: () => void;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });
    plane.handleHostMessageDurable = async (message) => {
      if (message.type === "host:register") {
        registrationStarted();
        await registrationBlocked;
      }
      return await originalHandle(message);
    };
    plane.disconnectHostDurable = async (connectionId) => {
      const result = await originalDisconnect(connectionId);
      resolveDisconnected();
      return result;
    };

    const server = createServer();
    const hub = bridge.attach(server, plane);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const opened = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await opened;
    ws.send(
      JSON.stringify({
        type: "host:register",
        hostId: "closed-during-register",
        protocolVersion: 7,
        daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
        daemonStartedAt: "2026-08-11T00:00:00.000Z",
        runningAttempts: [],
        worktrees: [
          {
            id: "closed-during-register-wt",
            name: "closed-during-register",
            repositoryId: "repo",
            path: "/tmp/closed-during-register",
            labels: [],
          },
        ],
        commandProfiles: [],
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      }),
    );
    await registrationStartedPromise;
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;
    releaseRegistration!();
    await disconnected;

    expect(hub.hostCount()).toBe(0);
    expect(plane.state.hostConnection.has("closed-during-register")).toBe(false);
    expect(plane.state.connections.size).toBe(0);
    expect(plane.state.worktrees.get("closed-during-register-wt")?.online).toBe(false);

    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("does not disconnect a replacement connection after a closed registration", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage, shardCount: 1 });
    const originalHandle = plane.handleHostMessageDurable.bind(plane);
    const originalDisconnect = plane.disconnectHostDurable.bind(plane);
    let releaseResult: () => void;
    const resultBlocked = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    let firstRegistrationFinished: () => void;
    const firstRegistrationFinishedPromise = new Promise<void>((resolve) => {
      firstRegistrationFinished = resolve;
    });
    let resolveDisconnected: () => void;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });
    let registrationCount = 0;
    let firstConnectionId: string | undefined;
    plane.handleHostMessageDurable = async (message) => {
      if (message.type === "host:register" && registrationCount++ === 0) {
        const result = await originalHandle(message);
        firstConnectionId = result.connectionId;
        firstRegistrationFinished();
        await resultBlocked;
        return result;
      }
      return await originalHandle(message);
    };
    plane.disconnectHostDurable = async (connectionId) => {
      const result = await originalDisconnect(connectionId);
      resolveDisconnected();
      return result;
    };

    const server = createServer();
    const hub = bridge.attach(server, plane);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");

    const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(
      JSON.stringify({
        type: "host:register",
        hostId: "replaced-after-close",
        protocolVersion: 7,
        daemonInstanceId: "123e4567-e89b-42d3-a456-426614174000",
        daemonStartedAt: "2026-08-11T00:00:00.000Z",
        runningAttempts: [],
        worktrees: [
          {
            id: "replaced-after-close-wt",
            name: "replaced-after-close",
            repositoryId: "repo",
            path: "/tmp/replaced-after-close",
            labels: [],
          },
        ],
        commandProfiles: [],
        runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
      }),
    );
    await firstRegistrationFinishedPromise;
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    ws.close();
    await closed;

    const replacement = await plane.registerHostDurable({
      hostId: "replaced-after-close",
      worktrees: [
        {
          id: "replaced-after-close-wt",
          name: "replaced-after-close",
          repositoryId: "repo",
          path: "/tmp/replaced-after-close",
          labels: [],
        },
      ],
      commandProfiles: [],
      replaceExisting: true,
    });
    expect(replacement.ok).toBe(true);
    expect(firstConnectionId).not.toBe(replacement.ok ? replacement.connectionId : undefined);

    releaseResult!();
    await disconnected;

    expect(hub.hostCount()).toBe(0);
    expect(plane.state.hostConnection.get("replaced-after-close")).toBe(
      replacement.ok ? replacement.connectionId : undefined,
    );
    expect(plane.state.connections.size).toBe(1);
    expect(plane.state.worktrees.get("replaced-after-close-wt")?.online).toBe(true);

    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
});
