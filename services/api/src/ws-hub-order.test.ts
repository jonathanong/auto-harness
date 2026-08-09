/* eslint-disable max-lines -- registration race scenarios share one websocket harness. */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("createPlaneWsBridge message ordering", () => {
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
