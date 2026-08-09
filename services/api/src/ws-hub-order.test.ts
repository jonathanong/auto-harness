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
});
