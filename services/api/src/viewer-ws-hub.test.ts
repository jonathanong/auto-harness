/* eslint-disable max-lines -- protocol security and cross-worker cases share a websocket harness. */
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";
import WebSocket from "ws";

import { AuthService, type Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { attachViewerWsHub } from "./viewer-ws-hub.ts";

describe("browser viewer websocket", () => {
  it("authenticates a browser cookie before upgrade and tails committed records in cursor order", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const cookie = issuedCookie(auth, principal);
    const plane = planeWithSession();
    plane.appendLog(log(1));
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth);
    await listen(server);
    const url = wsUrl(server, "/ws/viewer");

    await expectUnauthorizedUpgrade(url);
    const received = await new Promise<Array<{ type: string; record?: { timestampSeq: string } }>>(
      (resolve, reject) => {
        const messages: Array<{ type: string; record?: { timestampSeq: string } }> = [];
        const ws = new WebSocket(url, { headers: { cookie } });
        ws.on("open", () =>
          ws.send(JSON.stringify({ type: "viewer:subscribe", sessionId: "session-a" })),
        );
        ws.on("message", (raw) => {
          const message = JSON.parse(String(raw)) as {
            type: string;
            record?: { timestampSeq: string };
          };
          messages.push(message);
          if (message.type === "viewer:subscribed") plane.appendLog(log(2));
          if (messages.filter((item) => item.type === "viewer:log").length === 2) {
            ws.once("close", () => resolve(messages));
            ws.close();
          }
        });
        ws.on("error", reject);
      },
    );

    expect(
      received
        .filter((message) => message.type === "viewer:log")
        .map((message) => message.record?.timestampSeq),
    ).toEqual([log(1).timestampSeq, log(2).timestampSeq]);
    hub.close();
    await close(server);
  });

  it("rejects host-bound credentials and closes connections that attempt a host write", async () => {
    const auth = authService();
    const agent = await auth.createServiceAccount({
      name: "agent",
      role: "operator",
      boundHostId: "host-a",
    });
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const server = createServer();
    const hub = attachViewerWsHub(server, planeWithSession(), auth);
    await listen(server);
    const url = wsUrl(server, "/ws/viewer");

    await expectUnauthorizedUpgrade(url, { authorization: `Bearer ${agent.apiKey}` });
    const closeCode = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie: issuedCookie(auth, principal) } });
      ws.on("open", () => ws.send(JSON.stringify({ type: "session:log", sessionId: "session-a" })));
      ws.on("close", resolve);
      ws.on("error", reject);
    });
    expect(closeCode).toBe(1008);

    hub.close();
    await close(server);
  });

  it("caps each browser connection at eight session subscriptions", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSession();
    const source = plane.state.sessions.get("session-a")!;
    for (let index = 0; index < 8; index += 1) {
      plane.state.sessions.set(`session-${index}`, { ...source, id: `session-${index}` });
    }
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth);
    await listen(server);
    const url = wsUrl(server, "/ws/viewer");

    const errorCode = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie: issuedCookie(auth, principal) } });
      ws.on("open", () => {
        for (const sessionId of [
          "session-a",
          ...Array.from({ length: 8 }, (_, index) => `session-${index}`),
        ]) {
          ws.send(JSON.stringify({ type: "viewer:subscribe", sessionId }));
        }
      });
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string; code?: string };
        if (message.type === "viewer:error") {
          ws.close();
          resolve(message.code!);
        }
      });
      ws.on("error", reject);
    });
    expect(errorCode).toBe("SUBSCRIPTION_LIMIT");

    hub.close();
    await close(server);
  });

  it("sorts an out-of-order in-memory tail before paginating its cursor", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSession();
    plane.state.logs.set(
      "session-a",
      Array.from({ length: 300 }, (_, index) => log(300 - index)),
    );
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth);
    await listen(server);

    const received = await receiveLogs(
      wsUrl(server, "/ws/viewer"),
      issuedCookie(auth, principal),
      undefined,
      300,
    );
    expect(received).toEqual(
      Array.from({ length: 300 }, (_, index) => log(index + 1).timestampSeq),
    );

    hub.close();
    await close(server);
  });

  it("replays authoritative records committed by another worker after reconnect without a gap", async () => {
    const auth = authService();
    const principal = await auth.createUser({
      username: "viewer",
      password: "viewer-password",
      role: "read-only",
    });
    const plane = planeWithSession();
    const session = plane.state.sessions.get("session-a")!;
    const durableLogs = Array.from({ length: 300 }, (_, index) => log(index + 1));
    let cursorQueries = 0;
    const queriedAfter: Array<string | undefined> = [];
    plane.state.sessions.clear();
    plane.state.storage = {
      getSession: async () => session,
      queryLogs: async (_sessionId: string, query: { after?: string; limit: number }) => {
        cursorQueries += 1;
        queriedAfter.push(query.after);
        return durableLogs
          .filter((record) => !query.after || record.timestampSeq > query.after)
          .slice(0, query.limit);
      },
      listLogs: async () => {
        throw new Error("viewer poll must use a cursor query, not full history");
      },
    } as never;
    const server = createServer();
    const hub = attachViewerWsHub(server, plane, auth, { pollMs: 5 });
    await listen(server);
    const url = wsUrl(server, "/ws/viewer");
    const cookie = issuedCookie(auth, principal);

    expect(await receiveLogs(url, cookie, undefined, 300)).toHaveLength(300);
    expect(queriedAfter).toContain(log(250).timestampSeq);
    durableLogs.push(log(301));
    expect(await receiveLogs(url, cookie, log(300).timestampSeq, 1)).toEqual([
      log(301).timestampSeq,
    ]);
    expect(cursorQueries).toBeGreaterThanOrEqual(2);

    hub.close();
    await close(server);
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

function planeWithSession(): ControlPlane {
  const plane = new ControlPlane({ publicBaseUrl: "http://ui" });
  plane.state.sessions.set("session-a", {
    id: "session-a",
    repositoryId: "repo-a",
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

function wsUrl(server: ReturnType<typeof createServer>, path: string): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return `ws://127.0.0.1:${address.port}${path}`;
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

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function receiveLogs(
  url: string,
  cookie: string,
  after: string | undefined,
  count: number,
): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    const received: string[] = [];
    const ws = new WebSocket(url, { headers: { cookie } });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "viewer:subscribe",
          sessionId: "session-a",
          ...(after ? { after } : {}),
        }),
      ),
    );
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        type: string;
        record?: { timestampSeq: string };
      };
      if (message.type !== "viewer:log") return;
      received.push(message.record!.timestampSeq);
      if (received.length === count) {
        ws.close();
        resolve(received);
      }
    });
    ws.on("error", reject);
  });
}
