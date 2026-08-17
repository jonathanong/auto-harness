import { describe, expect, it, vi } from "vitest";

import type { Principal } from "./auth.ts";
import type { ConnectionRecord, LogRecord } from "./db/plane-storage-types.ts";
import { createLambdaViewerSockets } from "./lambda-viewer-websocket.ts";

const principal: Principal = {
  id: "user:viewer",
  username: "viewer",
  role: "operator",
  kind: "user",
  allowedRepositoryIds: ["repo-1"],
};

function fixture(authenticated: Principal | null = principal) {
  const connections = new Map<string, ConnectionRecord>();
  const sessions = new Map<string, { repositoryId: string; status: string }>();
  const logs = new Map<string, LogRecord[]>();
  const sent: Array<{ connectionId: string; message: Record<string, unknown> }> = [];
  const management = {
    send: vi.fn(async (command: { input: { ConnectionId?: string; Data?: Uint8Array } }) => {
      sent.push({
        connectionId: command.input.ConnectionId!,
        message: JSON.parse(Buffer.from(command.input.Data!).toString("utf8")) as Record<
          string,
          unknown
        >,
      });
      return {};
    }),
  };
  const storage = {
    deleteConnection: vi.fn(async (id: string) => void connections.delete(id)),
    getConnection: vi.fn(async (id: string) => connections.get(id) ?? null),
    getSession: vi.fn(async (id: string) => sessions.get(id) ?? null),
    listConnections: vi.fn(async () => [...connections.values()]),
    putConnection: vi.fn(async (connection: ConnectionRecord) => {
      connections.set(connection.connectionId, structuredClone(connection));
    }),
    queryLogs: vi.fn(async (id: string, query: { after?: string; limit: number }) =>
      (logs.get(id) ?? [])
        .filter(({ timestampSeq }) => !query.after || timestampSeq > query.after)
        .slice(0, query.limit),
    ),
  };
  const auth = { authenticateViewerTicket: vi.fn(async () => authenticated) };
  return {
    auth,
    connections,
    logs,
    management,
    sessions,
    sent,
    sockets: createLambdaViewerSockets({
      auth: auth as never,
      management: management as never,
      storage,
    }),
    storage,
  };
}

function log(timestampSeq: string, seq: number): LogRecord {
  return {
    sessionId: "session-1",
    timestampSeq,
    seq,
    stream: "stdout",
    content: `line ${seq}`,
    timestamp: timestampSeq.slice(0, timestampSeq.lastIndexOf("#")),
  };
}

describe("Lambda viewer WebSocket adapter", () => {
  it("authenticates viewer tickets and owns viewer disconnects", async () => {
    const denied = fixture(null);
    await expect(denied.sockets.connect("denied", "bad")).resolves.toBe(403);

    const serviceAccount = fixture({ ...principal, kind: "service-account" });
    await expect(serviceAccount.sockets.connect("service", "ticket")).resolves.toBe(403);

    const admin = fixture({
      id: "admin:root",
      username: "root",
      role: "admin",
      kind: "admin",
    });
    await expect(admin.sockets.connect("admin", "ticket")).resolves.toBe(200);

    const ctx = fixture();
    await expect(ctx.sockets.connect("viewer-1", "ticket")).resolves.toBe(200);
    expect(ctx.connections.get("viewer-1")).toMatchObject({
      type: "client",
      hostId: principal.id,
      viewerPrincipal: principal,
      viewerSubscriptions: [],
    });
    ctx.connections.set("host-1", {
      connectionId: "host-1",
      type: "host",
      hostId: "host-1",
      connectedAt: "now",
      lastHeartbeatAt: "now",
    });
    await expect(ctx.sockets.disconnect("missing")).resolves.toBe(false);
    await expect(ctx.sockets.disconnect("host-1")).resolves.toBe(false);
    await expect(ctx.sockets.disconnect("viewer-1")).resolves.toBe(true);
    expect(ctx.connections.has("viewer-1")).toBe(false);
  });

  it("rejects invalid viewer messages and manages subscriptions", async () => {
    const ctx = fixture();
    await expect(ctx.sockets.message("missing", "{}")).resolves.toBeUndefined();
    await ctx.sockets.connect("viewer-1", "ticket");
    await expect(ctx.sockets.message("viewer-1", "bad")).resolves.toBe(403);
    await expect(
      ctx.sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:subscribe", sessionId: "missing" }),
      ),
    ).resolves.toBe(200);
    expect(ctx.sent.at(-1)?.message).toMatchObject({ code: "NOT_FOUND" });

    ctx.sessions.set("session-1", { repositoryId: "repo-1", status: "running" });
    ctx.logs.set("session-1", [
      log("2026-08-17T00:00:02.000Z#0000000002", 2),
      log("2026-08-17T00:00:01.000Z#0000000001", 1),
    ]);
    await expect(
      ctx.sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
      ),
    ).resolves.toBe(200);
    expect(ctx.sent.slice(-3).map(({ message }) => message.type)).toEqual([
      "session:log",
      "session:log",
      "session:subscribed",
    ]);
    expect(ctx.connections.get("viewer-1")?.viewerSubscriptions?.[0]?.after).toContain(
      "0000000002",
    );
    await ctx.sockets.message(
      "viewer-1",
      JSON.stringify({
        type: "session:subscribe",
        sessionId: "session-1",
        after: "2026-08-17T00:00:02.000Z#0000000002",
      }),
    );
    await ctx.sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:unsubscribe", sessionId: "session-1" }),
    );
    expect(ctx.connections.get("viewer-1")?.viewerSubscriptions).toEqual([]);
  });

  it("enforces viewer repository scope and subscription limits", async () => {
    const ctx = fixture();
    await ctx.sockets.connect("viewer-1", "ticket");
    ctx.sessions.set("forbidden", { repositoryId: "repo-2", status: "queued" });
    await ctx.sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "forbidden" }),
    );
    expect(ctx.sent.at(-1)?.message).toMatchObject({ code: "NOT_FOUND" });

    const connection = ctx.connections.get("viewer-1")!;
    connection.viewerSubscriptions = Array.from({ length: 8 }, (_, index) => ({
      sessionId: `existing-${index}`,
      repositoryId: "repo-1",
      status: "running",
    }));
    ctx.connections.set("viewer-1", connection);
    ctx.sessions.set("session-1", { repositoryId: "repo-1", status: "running" });
    await ctx.sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    expect(ctx.sent.at(-1)?.message).toMatchObject({ code: "SUBSCRIPTION_LIMIT" });
  });
});
