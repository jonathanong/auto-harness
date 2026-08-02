import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { createWsTransport } from "./ws-transport.js";

describe("createWsTransport", () => {
  it("connects, sends, and receives assign", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    const got: unknown[] = [];
    wss.on("connection", (sock) => {
      sock.on("message", (raw) => {
        got.push(JSON.parse(String(raw)));
        sock.send(
          JSON.stringify({
            type: "session:assign",
            sessionId: "s1",
            repositoryId: "r",
            prompt: "p",
            commandProfile: "c",
            timeout: 1,
            worktreeId: "w",
            assignedAt: "t",
          }),
        );
      });
    });
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

    const transport = createWsTransport({
      url: `ws://127.0.0.1:${addr.port}/ws`,
      agentId: "a1",
    });
    await transport.ready;
    let assignSeen = false;
    transport.onMessage((m) => {
      if (m.type === "session:assign") {
        assignSeen = true;
      }
    });
    await transport.send({
      type: "agent:register",
      agentId: "a1",
      worktrees: [],
      commandProfiles: ["c"],
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(got.some((m) => (m as { type: string }).type === "agent:register")).toBe(true);
    expect(assignSeen).toBe(true);
    transport.close();
    wss.close();
    await new Promise<void>((resolve, reject) => {
      server.close((e) => {
        if (e) {
          reject(e);
          return;
        }
        resolve();
      });
    });
  });
});
