/* eslint-disable max-lines -- protocol security and cursor-delivery cases share one socket harness. */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { AuthService, type Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { attachViewerWsHub } from "./viewer-ws-hub.ts";
import { parseViewerMessage } from "./viewer-ws-protocol.ts";
import { createPlaneWsBridge } from "./ws-hub.ts";

describe("browser session log websocket", () => {
  it("authenticates the browser session, replays in cursor order, and receives a committed tail", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSessions();
    plane.appendLog(log(1));
    plane.state.onLogCommitted = () => undefined;
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth);
    expect(hub.viewerCount()).toBe(0);
    await listen(server);
    const url = wsUrl(server);

    await expectUnauthorizedUpgrade(url);
    const received = await new Promise<string[]>((resolve, reject) => {
      const records: string[] = [];
      const ticket = auth.issueViewerTicket(principal);
      const ws = new WebSocket(`${url}?ticket=${encodeURIComponent(ticket)}`);
      ws.on("open", () =>
        ws.send(
          JSON.stringify({
            type: "session:subscribe",
            sessionId: "session-a",
            after: log(1).timestampSeq,
          }),
        ),
      );
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; timestampSeq?: string };
        if (message.type === "session:subscribed") {
          plane.appendLog({ ...log(3), sessionId: "session-b" });
          plane.appendLog(log(1));
          plane.appendLog(log(2));
        }
        if (message.type === "session:log") records.push(message.timestampSeq!);
        if (records.length === 1) {
          ws.send(JSON.stringify({ type: "session:unsubscribe", sessionId: "session-a" }));
          ws.once("close", () => resolve(records));
          ws.close();
        }
      });
      ws.on("error", reject);
    });

    expect(received).toEqual([log(2).timestampSeq]);
    hub.close();
    await close(server);
  });

  it("ignores upgrade requests without a URL", () => {
    const server = createServer();
    const hub = attachViewerWsHub(server, planeWithSessions(), authService());
    expect(server.emit("upgrade", {} as never, {} as never, Buffer.alloc(0))).toBe(true);
    hub.close();
  });

  it("hides sessions outside the authenticated principal repository scope", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "scoped",
      password: "viewer-password",
      role: "read-only",
    });
    const users = (auth as unknown as { users: Map<string, { allowedRepositoryIds?: string[] }> })
      .users;
    users.get("scoped")!.allowedRepositoryIds = ["repo-a"];
    const server = createServer();
    const hub = attachViewerWsHub(server, planeWithSessions(), auth);
    await listen(server);

    const code = await receiveError(
      wsUrl(server),
      issuedCookie(auth, { ...principal, allowedRepositoryIds: ["repo-a"] }),
      "session-b",
    );
    expect(code).toBe("NOT_FOUND");
    hub.close();
    await close(server);
  });

  it("shares the API upgrade server with the host control socket", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSessions();
    const bridge = createPlaneWsBridge();
    const server = createServer();
    const hostHub = bridge.attach(server, plane, auth);
    const viewerHub = attachViewerWsHub(server, plane, auth);
    await listen(server);

    await new Promise<void>((resolve, reject) => {
      const ticket = auth.issueViewerTicket(principal);
      const ws = new WebSocket(`${wsUrl(server)}?ticket=${encodeURIComponent(ticket)}`);
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "session:subscribe", sessionId: "session-a" })),
      );
      ws.on("message", (raw) => {
        if ((JSON.parse(String(raw)) as { type: string }).type === "session:subscribed") {
          ws.once("close", resolve);
          ws.close();
        }
      });
      ws.on("error", reject);
    });

    viewerHub.close();
    hostHub.close();
    await close(server);
  });

  it("rejects agent credentials, invalid frames, and excess subscriptions", async () => {
    const auth = authService();
    const agent = await auth.createServiceAccount({
      name: "agent",
      role: "agent",
      boundHostId: "host-a",
    });
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSessions();
    const source = plane.state.sessions.get("session-a")!;
    for (let index = 0; index < 8; index += 1) {
      plane.state.sessions.set(`session-${index}`, { ...source, id: `session-${index}` });
    }
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth);
    await listen(server);
    const url = wsUrl(server);
    await expectUnauthorizedUpgrade(url, { authorization: `Bearer ${agent.apiKey}` });

    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie: issuedCookie(auth, principal) } });
      ws.on("open", () => ws.send(JSON.stringify({ type: "session:log", sessionId: "session-a" })));
      ws.on("close", resolve);
      ws.on("error", reject);
    });
    expect(closeCode).toBe(1008);

    const limit = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie: issuedCookie(auth, principal) } });
      ws.on("open", () => {
        for (const sessionId of [
          "session-a",
          ...Array.from({ length: 8 }, (_, i) => `session-${i}`),
        ]) {
          ws.send(JSON.stringify({ type: "session:subscribe", sessionId }));
        }
      });
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; code?: string };
        if (message.type === "session:error") {
          ws.close();
          resolve(message.code!);
        }
      });
      ws.on("error", reject);
    });
    expect(limit).toBe("SUBSCRIPTION_LIMIT");
    hub.close();
    await close(server);
  });

  it("uses durable cursors to bridge another worker and reports changed lifecycle status", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSessions();
    const session = plane.state.sessions.get("session-a")!;
    const records = Array.from({ length: 251 }, (_, index) => log(index + 1));
    plane.state.sessions.clear();
    let reads = 0;
    plane.state.storage = {
      getSession: async () => ({ ...session, status: reads++ === 0 ? "running" : "completed" }),
      queryLogs: async (_id: string, query: { after?: string; limit: number }) =>
        records
          .filter((record) => !query.after || record.timestampSeq > query.after)
          .slice(0, query.limit),
    } as never;
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth, { pollMs: 5 });
    await listen(server);

    const messages = await new Promise<
      Array<{ type: string; status?: string; timestampSeq?: string }>
    >((resolve, reject) => {
      const received: Array<{ type: string; status?: string; timestampSeq?: string }> = [];
      const ws = new WebSocket(wsUrl(server), {
        headers: { cookie: issuedCookie(auth, principal) },
      });
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "session:subscribe", sessionId: "session-a" })),
      );
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as {
          type: string;
          status?: string;
          timestampSeq?: string;
        };
        received.push(message);
        if (
          received.filter((item) => item.type === "session:log").length === 251 &&
          received.some((item) => item.type === "session:subscribed") &&
          received.some((item) => item.type === "session:status" && item.status === "completed")
        ) {
          ws.once("close", () => resolve(received));
          ws.close();
        }
      });
      ws.on("error", reject);
    });
    expect(messages.filter((message) => message.type === "session:log")).toHaveLength(251);
    expect(messages.find((message) => message.type === "session:subscribed")?.status).toBe(
      "running",
    );
    expect(messages.find((message) => message.type === "session:status")?.status).toBe("completed");
    hub.close();
    await close(server);
  });

  it("delivers replay records before live commits that arrive during the durable query", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSessions();
    const session = plane.state.sessions.get("session-a")!;
    let releaseReplay!: () => void;
    let markReplayStarted!: () => void;
    const replayStarted = new Promise<void>((resolve) => (markReplayStarted = resolve));
    const replayGate = new Promise<void>((resolve) => (releaseReplay = resolve));
    plane.state.storage = {
      getSession: async () => session,
      queryLogs: async () => {
        markReplayStarted();
        await replayGate;
        return [log(1)];
      },
    } as never;
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth, { pollMs: 60_000 });
    await listen(server);

    const received = new Promise<string[]>((resolve, reject) => {
      const records: string[] = [];
      const ws = new WebSocket(wsUrl(server), {
        headers: { cookie: issuedCookie(auth, principal) },
      });
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "session:subscribe", sessionId: "session-a" })),
      );
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; timestampSeq?: string };
        if (message.type === "session:log") records.push(message.timestampSeq!);
        if (message.type === "session:subscribed") {
          ws.once("close", () => resolve(records));
          ws.close();
        }
      });
      ws.on("error", reject);
    });
    await replayStarted;
    plane.state.onLogCommitted?.(log(2));
    releaseReplay();

    await expect(received).resolves.toEqual([log(1).timestampSeq, log(2).timestampSeq]);
    hub.close();
    await close(server);
  });

  it("closes a subscription when its durable session disappears", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSessions();
    const session = plane.state.sessions.get("session-a")!;
    let reads = 0;
    plane.state.storage = {
      getSession: async () => (reads++ === 0 ? session : null),
      queryLogs: async () => [],
    } as never;
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth, { pollMs: 5 });
    await listen(server);

    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(wsUrl(server), {
        headers: { cookie: issuedCookie(auth, principal) },
      });
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "session:subscribe", sessionId: "session-a" })),
      );
      ws.on("close", resolve);
      ws.on("error", reject);
    });
    expect(closeCode).toBe(1008);
    hub.close();
    await close(server);
  });

  it("reports a temporary error when durable tail polling fails", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSessions();
    const session = plane.state.sessions.get("session-a")!;
    let reads = 0;
    plane.state.storage = {
      getSession: async () => {
        if (reads++ === 0) return session;
        throw new Error("temporary storage failure");
      },
      queryLogs: async () => [],
    } as never;
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth, { pollMs: 5 });
    await listen(server);

    const code = await receiveError(wsUrl(server), issuedCookie(auth, principal), "session-a");
    expect(code).toBe("TEMPORARY_FAILURE");
    hub.close();
    await close(server);
  });
});

describe("browser session log protocol", () => {
  it("accepts subscribe cursors and unsubscribe while rejecting malformed client input", () => {
    expect(
      parseViewerMessage(JSON.stringify({ type: "session:subscribe", sessionId: "s" })),
    ).toEqual({ type: "session:subscribe", sessionId: "s" });
    expect(
      parseViewerMessage(JSON.stringify({ type: "session:unsubscribe", sessionId: "s" })),
    ).toEqual({ type: "session:unsubscribe", sessionId: "s" });
    expect(
      parseViewerMessage(
        JSON.stringify({
          type: "session:subscribe",
          sessionId: "s",
          after: "2026-08-10T12:00:00.000Z#0000000001",
        }),
      ),
    ).not.toBeNull();
    expect(parseViewerMessage(JSON.stringify([]))).toBeNull();
    expect(
      parseViewerMessage(JSON.stringify({ type: "session:subscribe", sessionId: "s", after: 1 })),
    ).toBeNull();
    expect(
      parseViewerMessage(
        JSON.stringify({
          type: "session:subscribe",
          sessionId: "s",
          after: "2026-08-10T12:00:00.000Z#000000000",
        }),
      ),
    ).toBeNull();
    expect(parseViewerMessage("not json")).toBeNull();
    expect(
      parseViewerMessage(
        JSON.stringify({ type: "session:subscribe", sessionId: "", after: "bad" }),
      ),
    ).toBeNull();
  });
});

function authService(): AuthService {
  return new AuthService({
    mode: "required",
    secret: "a".repeat(32),
    admins: Buffer.from(JSON.stringify([{ username: "root", password: "root-password" }])).toString(
      "base64url",
    ),
  });
}

function issuedCookie(auth: AuthService, principal: Principal): string {
  let cookie = "";
  auth.issueCookie(
    { setHeader: (_name: string, value: string) => (cookie = value) } as never,
    principal,
  );
  return cookie;
}

function planeWithSessions(): ControlPlane {
  const plane = new ControlPlane({ publicBaseUrl: "http://ui" });
  for (const [id, repositoryId] of [
    ["session-a", "repo-a"],
    ["session-b", "repo-b"],
  ] as const) {
    plane.state.sessions.set(id, {
      id,
      repositoryId,
      prompt: "p",
      target: { commandId: "cmd-a" },
      fallbacks: [],
      targetLabels: [],
      queueTtlSeconds: 60,
      queueExpiresAt: "2099-01-01T00:00:00.000Z",
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-10T12:00:00.000Z",
    });
  }
  return plane;
}

function log(seq: number) {
  const timestamp = "2026-08-10T12:00:00.000Z";
  return {
    sessionId: "session-a",
    stream: "stdout",
    content: `line ${seq}`,
    timestamp,
    seq,
    timestampSeq: `${timestamp}#${String(seq).padStart(10, "0")}`,
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.on("error", reject);
  });
}

function wsUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `ws://127.0.0.1:${address.port}/ws/viewer`;
}

async function expectUnauthorizedUpgrade(
  url: string,
  headers?: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = headers ? new WebSocket(url, { headers }) : new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("unauthorized upgrade timeout")), 3_000);
    ws.on("unexpected-response", (_request, response) => {
      clearTimeout(timer);
      expect(response.statusCode).toBe(401);
      resolve();
    });
    ws.on("error", () => undefined);
  });
}

async function receiveError(url: string, cookie: string, sessionId: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { cookie } });
    ws.on("open", () => ws.send(JSON.stringify({ type: "session:subscribe", sessionId })));
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; code?: string };
      if (message.type === "session:error") {
        ws.close();
        resolve(message.code!);
      }
    });
    ws.on("error", reject);
  });
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
