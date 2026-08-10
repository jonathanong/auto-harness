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
      _sock.send(JSON.stringify({ type: "host:registered", hostId: "a1" }));
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
        sock.send(JSON.stringify({ type: "host:registered", hostId: "a1" }));
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
    let resolveAssign!: () => void;
    const assignReceived = new Promise<void>((resolve) => {
      resolveAssign = resolve;
    });
    transport.onMessage((m) => {
      if (m.type === "session:assign") {
        assignSeen = true;
        resolveAssign();
      }
    });
    await transport.send({
      type: "host:register",
      hostId: "a1",
      worktrees: [],
      commandProfiles: ["c"],
    });
    await assignReceived;
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

  it("ignores assignments until the registration barrier opens", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (sock) => {
      sock.send(JSON.stringify(assign("before")));
      sock.on("message", () => {
        sock.send(JSON.stringify({ type: "host:registered", hostId: "a1" }));
        sock.send(JSON.stringify(assign("after")));
      });
    });
    await listen(server);
    const transport = createWsTransport({ url: `ws://127.0.0.1:${port(server)}/ws`, hostId: "a1" });
    const seen: string[] = [];
    let resolveAfter!: () => void;
    const afterReceived = new Promise<void>((resolve) => {
      resolveAfter = resolve;
    });
    transport.onMessage((message) => {
      if (message.type === "session:assign") {
        seen.push(message.sessionId);
        if (message.sessionId === "after") resolveAfter();
      }
    });
    await transport.ready;
    await transport.send(register());
    await afterReceived;
    expect(seen).toEqual(["after"]);
    transport.close();
    await close(wss, server);
  });

  it("retries a refused registration and only resolves registered after acceptance", async () => {
    const server = createServer();
    const wss = new WebSocketServer({ server, path: "/ws" });
    let registrations = 0;
    wss.on("connection", (sock) => {
      sock.on("message", () => {
        registrations++;
        sock.send(
          JSON.stringify(
            registrations === 1 ? { type: "error" } : { type: "host:registered", hostId: "a1" },
          ),
        );
      });
    });
    await listen(server);
    const transport = createWsTransport({ url: `ws://127.0.0.1:${port(server)}/ws`, hostId: "a1" });
    await transport.ready;
    await transport.send(register());
    await transport.registered;
    expect(registrations).toBe(2);
    transport.close();
    await close(wss, server);
  });
});

function assign(sessionId: string) {
  return {
    type: "session:assign",
    sessionId,
    repositoryId: "r",
    prompt: "p",
    resolvedArgv: ["c"],
    timeout: 1,
    worktreeId: "w",
    assignedAt: "t",
  };
}

function register() {
  return { type: "host:register" as const, hostId: "a1", worktrees: [], commandProfiles: [] };
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
}

function port(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function close(wss: WebSocketServer, server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
