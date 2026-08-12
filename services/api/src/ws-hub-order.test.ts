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
): Promise<{
  ws: WebSocket;
  hub: ReturnType<typeof bridge.attach>;
  server: ReturnType<typeof createServer>;
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
        JSON.stringify({ type: "host:register", hostId, worktrees: [], commandProfiles: [] }),
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
  return { ws, hub, server };
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

const wireLog = (sessionId: string, seq = 1) =>
  JSON.stringify({
    type: "session:log",
    sessionId,
    stream: "stdout",
    content: "line",
    timestamp: "2026-01-01T00:00:00.000Z",
    seq,
  });

describe("createPlaneWsBridge message ordering", () => {
  it("reports a fenced batch rejection after the default coalescing window", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage });
    plane.state.sessions.set("rejected-session", { hostId: "rejected-host" } as never);
    const opened = await registeredSocket(bridge, plane, "rejected-host");
    const connectionId = plane.state.hostConnection.get("rejected-host")!;
    plane.state.storage = {
      getSession: async () => ({ hostId: "rejected-host" }),
      getHostLock: async () => connectionId,
      putLogsFenced: async () => false,
      releaseHostConnection: async () => true,
    } as never;
    const error = new Promise<{ type: string; message: string }>((resolve) => {
      opened.ws.on("message", (raw) => {
        const value = JSON.parse(String(raw));
        if (value.type === "error") resolve(value);
      });
    });
    opened.ws.send(wireLog("rejected-session"));
    await expect(error).resolves.toEqual({ type: "error", message: "stale host connection" });
    await closeHub(opened.ws, opened.hub, opened.server);
  });

  it("closes unauthorized and stale sockets before committing their log batch", async () => {
    for (const mode of ["unauthorized-empty", "unauthorized-mixed", "stale"] as const) {
      const unauthorized = mode.startsWith("unauthorized");
      const bridge = createPlaneWsBridge({
        logBatchDelayMs: unauthorized ? 60_000 : 0,
      });
      const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage });
      plane.state.sessions.set(`${mode}-allowed`, { hostId: `${mode}-host` } as never);
      plane.state.sessions.set(`${mode}-session`, {
        hostId: unauthorized ? "another-host" : `${mode}-host`,
      } as never);
      const opened = await registeredSocket(bridge, plane, `${mode}-host`);
      if (mode === "stale") {
        plane.state.hostConnection.set(`${mode}-host`, "replacement-connection");
      }
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        opened.ws.on("close", (code, reason) => resolve({ code, reason: String(reason) }));
      });
      if (mode === "unauthorized-mixed") opened.ws.send(wireLog(`${mode}-allowed`, 0));
      opened.ws.send(wireLog(`${mode}-session`, 1));
      if (unauthorized) {
        opened.ws.send(
          JSON.stringify({
            type: "host:keepalive",
            hostId: `${mode}-host`,
            at: "2026-01-01T00:00:00.000Z",
          }),
        );
      }
      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: unauthorized ? "message not authorized" : "stale host connection",
      });
      opened.hub.close();
      await new Promise<void>((resolve, reject) =>
        opened.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not write an error frame after a closing socket rejects a batch", async () => {
    const bridge = createPlaneWsBridge({ logBatchDelayMs: 0 });
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage });
    plane.state.sessions.set("closing-session", { hostId: "closing-host" } as never);
    const opened = await registeredSocket(bridge, plane, "closing-host");
    const connectionId = plane.state.hostConnection.get("closing-host")!;
    let resolveWrite: ((accepted: boolean) => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      plane.state.storage = {
        getSession: async () => ({ hostId: "closing-host" }),
        getHostLock: async () => connectionId,
        putLogsFenced: async () =>
          new Promise<boolean>((finish) => {
            resolveWrite = finish;
            resolve();
          }),
        releaseHostConnection: async () => true,
      } as never;
    });
    opened.ws.send(wireLog("closing-session"));
    await writeStarted;
    const closed = new Promise<void>((resolve) => opened.ws.on("close", () => resolve()));
    opened.ws.close();
    await closed;
    resolveWrite!(false);
    // The assertion targets the closed-socket response branch; use the local
    // disconnect path after that pending durable write settles.
    plane.state.storage = undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    opened.hub.close();
    await new Promise<void>((resolve, reject) =>
      opened.server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("batches adjacent log frames without letting a control frame overtake them", async () => {
    const bridge = createPlaneWsBridge({ logBatchDelayMs: 60_000 });
    const plane = new ControlPlane({ onHostMessage: bridge.onHostMessage, shardCount: 1 });
    plane.state.sessions.set("batched-session", { hostId: "batched-host" } as never);
    const originalHandle = plane.handleHostMessageDurable.bind(plane);
    const observed: Array<string | number[]> = [];
    plane.handleHostMessageDurable = async (message, ...args) => {
      if (message.type === "host:register") return originalHandle(message, ...args);
      observed.push(message.type);
      return { ok: true };
    };

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
            hostId: "batched-host",
            worktrees: [],
            commandProfiles: [],
          }),
        ),
      );
      ws.on("message", (raw) => {
        if (JSON.parse(String(raw)).type !== "host:registered") return;
        const connectionId = plane.state.hostConnection.get("batched-host")!;
        plane.state.storage = {
          getSession: async () => ({ hostId: "batched-host" }),
          getHostLock: async () => connectionId,
          putLogsFenced: async (records: Array<{ seq: number }>) => {
            observed.push(records.map(({ seq }) => seq));
            return true;
          },
          deleteLog: async () => {},
          heartbeatConnection: async () => {
            observed.push("host:keepalive");
            return true;
          },
        } as never;
        for (let seq = 0; seq < 30; seq++) {
          ws.send(
            JSON.stringify({
              type: "session:log",
              sessionId: "batched-session",
              stream: "stdout",
              content: String(seq),
              timestamp: "2026-01-01T00:00:00.000Z",
              seq,
            }),
          );
        }
        ws.send(
          JSON.stringify({
            type: "host:keepalive",
            hostId: "batched-host",
            at: "2026-01-01T00:00:00.000Z",
          }),
        );
      });
      const poll = setInterval(() => {
        if (observed.includes("host:keepalive")) {
          clearInterval(poll);
          resolve();
        }
      }, 1);
      ws.on("error", reject);
    });

    expect(observed).toEqual([
      Array.from({ length: 25 }, (_, seq) => seq),
      Array.from({ length: 5 }, (_, index) => index + 25),
      "host:keepalive",
    ]);
    ws.close();
    hub.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
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
            worktrees: [],
            commandProfiles: [],
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
