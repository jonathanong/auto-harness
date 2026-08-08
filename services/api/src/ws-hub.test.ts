import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { ControlPlane } from "./control-plane.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("createPlaneWsBridge", () => {
  it("registers agent and delivers session:assign", async () => {
    const bridge = createPlaneWsBridge();
    const plane = new ControlPlane({
      onAgentMessage: bridge.onAgentMessage,
      idFactory: () => "sess-1",
      shardCount: 1,
    });
    plane.createCommand({
      id: "cmd-echo",
      name: "echo-prompt",
      argv: ["echo"],
      providerId: null,
    });
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
      repositoryId: "r1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });

    const server = createServer();
    const hub = bridge.attach(server, plane);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        resolve();
      });
      server.on("error", reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("no port");
    }

    const received: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "host:register",
            hostId: "a1",
            worktrees: [{ id: "wt-1", repositoryId: "r1", path: "/w", labels: [] }],
            commandProfiles: ["echo-prompt"],
          }),
        );
      });
      ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw)) as { type: string };
        received.push(msg);
        if (msg.type === "host:registered") {
          plane.createSession({
            repositoryId: "r1",
            prompt: "p",
            commandId: "cmd-echo",
            timeout: 10,
          });
          plane.assignQueued();
        }
        if (msg.type === "session:assign") {
          ws.close();
          resolve();
        }
      });
      ws.on("error", reject);
      setTimeout(() => {
        reject(new Error("timeout"));
      }, 3000);
    });

    expect(received.some((m) => (m as { type: string }).type === "session:assign")).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    hub.close();
    expect(hub.agentCount()).toBe(0);
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  });
});
