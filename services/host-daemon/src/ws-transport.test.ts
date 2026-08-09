import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { createWsTransport } from "./ws-transport.ts";

describe("createWsTransport", () => {
  it("sends the service-account key as an authorization header", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    let authorization: string | undefined;
    let requestUrl: string | undefined;
    wss.on("connection", (_sock, request) => {
      authorization = request.headers.authorization;
      requestUrl = request.url;
    });
    let transport: ReturnType<typeof createWsTransport> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.on("error", reject);
      });
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no port");
      }

      transport = createWsTransport({
        url: `ws://127.0.0.1:${addr.port}/ws`,
        hostId: "a1",
        apiKey: "hns_test-key",
      });
      await transport.ready;
      expect(authorization).toBe("Bearer hns_test-key");
      expect(requestUrl).toBe("/ws?hostId=a1");
    } finally {
      transport?.close();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

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
            resolvedArgv: ["c"],
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
      hostId: "a1",
    });
    await transport.ready;
    let assignSeen = false;
    transport.onMessage((m) => {
      if (m.type === "session:assign") {
        assignSeen = true;
      }
    });
    await transport.send({
      type: "host:register",
      hostId: "a1",
      worktrees: [],
      commandProfiles: ["c"],
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(got.some((m) => (m as { type: string }).type === "host:register")).toBe(true);
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
