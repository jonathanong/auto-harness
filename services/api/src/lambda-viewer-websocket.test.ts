/* eslint-disable max-lines -- viewer socket outcomes share one adapter fixture. */
import { GoneException } from "@aws-sdk/client-apigatewaymanagementapi";
import { describe, expect, it, vi } from "vitest";

import type { Principal } from "./auth.ts";
import type { ConnectionRecord, LogRecord } from "./db/plane-storage-types.ts";
import { VIEWER_FANOUT_PREFIX } from "./lambda-viewer-fanout.ts";
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
      publicBaseUrl: "https://app.example.test",
    }),
    storage,
  };
}

const origin = "https://app.example.test";

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
  it("fails closed when no browser origin is configured", async () => {
    const ctx = fixture();
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
    });
    await expect(sockets.connect("viewer-1", "ticket", origin)).resolves.toBe(403);
  });

  it("retries a missing origin lookup on later connects and then caches it", async () => {
    const ctx = fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const resolvePublicBaseUrl = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(origin);
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
      resolvePublicBaseUrl,
    });
    await expect(sockets.connect("viewer-1", "ticket", origin)).resolves.toBe(403);
    await expect(sockets.connect("viewer-1", "ticket", origin)).resolves.toBe(403);
    expect(resolvePublicBaseUrl).toHaveBeenCalledTimes(1);
    now.mockReturnValue(6_000);
    await expect(sockets.connect("viewer-1", "ticket", origin)).resolves.toBe(200);
    await expect(sockets.connect("viewer-2", "ticket", origin)).resolves.toBe(200);
    expect(resolvePublicBaseUrl).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  it("coalesces concurrent origin lookups", async () => {
    const ctx = fixture();
    let release!: (value: string | undefined) => void;
    const resolvePublicBaseUrl = vi.fn(
      () => new Promise<string | undefined>((resolve) => (release = resolve)),
    );
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
      resolvePublicBaseUrl,
    });
    const first = sockets.connect("viewer-1", "ticket", origin);
    const second = sockets.connect("viewer-2", "ticket", origin);
    await vi.waitFor(() => expect(resolvePublicBaseUrl).toHaveBeenCalledOnce());
    release(origin);
    await expect(first).resolves.toBe(200);
    await expect(second).resolves.toBe(200);
    expect(resolvePublicBaseUrl).toHaveBeenCalledTimes(1);
  });

  it("authenticates viewer tickets and owns viewer disconnects", async () => {
    const denied = fixture(null);
    await expect(denied.sockets.connect("denied", "bad")).resolves.toBe(403);
    await expect(denied.sockets.connect("denied", "bad", origin)).resolves.toBe(403);

    const serviceAccount = fixture({ ...principal, kind: "service-account" });
    await expect(serviceAccount.sockets.connect("service", "ticket", origin)).resolves.toBe(403);

    const admin = fixture({
      id: "admin:root",
      username: "root",
      role: "admin",
      kind: "admin",
    });
    await expect(admin.sockets.connect("admin", "ticket", origin)).resolves.toBe(200);

    const ctx = fixture();
    await expect(
      ctx.sockets.connect("viewer-1", "ticket", "https://evil.example.test"),
    ).resolves.toBe(403);
    await expect(ctx.sockets.connect("viewer-1", "ticket", origin)).resolves.toBe(200);
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
    await ctx.sockets.connect("viewer-1", "ticket", origin);
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
    expect(ctx.sent.at(-1)?.message).toMatchObject({
      type: "session:subscribed",
      sessionId: "session-1",
      cursor: null,
      status: "running",
    });
    expect(ctx.connections.get("viewer-1")?.viewerSubscriptions?.[0]).not.toHaveProperty("after");
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
    await ctx.sockets.connect("viewer-1", "ticket", origin);
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

  it("handles sparse subscriptions and prunes a gone viewer during subscribe ack", async () => {
    const ctx = fixture();
    await ctx.sockets.connect("viewer-1", "ticket", origin);
    const connection = ctx.connections.get("viewer-1")!;
    delete connection.viewerSubscriptions;
    ctx.connections.set("viewer-1", connection);
    await expect(
      ctx.sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:unsubscribe", sessionId: "session-1" }),
      ),
    ).resolves.toBe(200);

    ctx.sessions.set("session-1", { repositoryId: "repo-1", status: "running" });
    await expect(
      ctx.sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
      ),
    ).resolves.toBe(200);
    expect(ctx.connections.get("viewer-1")?.viewerSubscriptions?.[0]).not.toHaveProperty("after");

    ctx.connections.get("viewer-1")!.viewerSubscriptions!.push({
      sessionId: "other-session",
      repositoryId: "repo-1",
      status: "running",
    });
    await expect(
      ctx.sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
      ),
    ).resolves.toBe(200);
    expect(ctx.connections.get("viewer-1")?.viewerSubscriptions).toHaveLength(2);

    ctx.logs.set("session-1", [log("2026-08-17T00:00:01.000Z#0000000001", 1)]);
    ctx.management.send.mockRejectedValueOnce({ name: "GoneException" });
    await expect(
      ctx.sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
      ),
    ).resolves.toBe(200);
    expect(ctx.connections.has("viewer-1")).toBe(false);
  });

  it("clears host watch when the first subscribe acknowledgement is gone", async () => {
    const watches: Array<[string, string, boolean]> = [];
    const ctx = fixture();
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
      publicBaseUrl: origin,
      onSessionWatch: (hostId, sessionId, watching) => {
        watches.push([hostId, sessionId, watching]);
      },
    });
    await sockets.connect("viewer-1", "ticket", origin);
    ctx.sessions.set("session-1", { repositoryId: "repo-1", status: "running", hostId: "host-1" });
    ctx.management.send.mockRejectedValueOnce({ name: "GoneException" });
    await expect(
      sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
      ),
    ).resolves.toBe(200);
    expect(watches).toEqual([
      ["host-1", "session-1", true],
      ["host-1", "session-1", false],
    ]);
  });

  it("clears host watch on last unsubscribe and skips unsubscribed log-part fan-out", async () => {
    const watches: Array<[string, string, boolean]> = [];
    const ctx = fixture();
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
      publicBaseUrl: origin,
      onSessionWatch: (hostId, sessionId, watching) => {
        watches.push([hostId, sessionId, watching]);
      },
    });
    await sockets.connect("viewer-1", "ticket", origin);
    ctx.sessions.set("session-1", {
      repositoryId: "repo-1",
      status: "running",
      hostId: "host-1",
    });
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    expect(watches).toEqual([["host-1", "session-1", true]]);
    await sockets.publishLogPart({
      sessionId: "session-1",
      key: "sessions/session-1/parts/1-1.jsonl.gz",
      seqStart: 1,
      seqEnd: 1,
    });
    expect(ctx.sent.some((item) => item.message.type === "session:log-part")).toBe(true);
    ctx.connections.get("viewer-1")!.viewerSubscriptions = [];
    await sockets.publishLogPart({
      sessionId: "session-1",
      key: "sessions/session-1/parts/2-2.jsonl.gz",
      seqStart: 2,
      seqEnd: 2,
    });
    ctx.connections.get("viewer-1")!.viewerSubscriptions = [
      { sessionId: "session-1", repositoryId: "repo-1", status: "running" },
    ];
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:unsubscribe", sessionId: "session-1" }),
    );
    expect(watches).toEqual([
      ["host-1", "session-1", true],
      ["host-1", "session-1", false],
    ]);
    ctx.connections.set("viewer-1", {
      ...ctx.connections.get("viewer-1")!,
      type: "client",
      viewerSubscriptions: [{ sessionId: "session-1", repositoryId: "repo-1", status: "running" }],
    });
    ctx.management.send.mockRejectedValueOnce({ name: "GoneException" });
    await sockets.publishLogPart({
      sessionId: "session-1",
      key: "sessions/session-1/parts/3-3.jsonl.gz",
      seqStart: 3,
      seqEnd: 3,
    });
    expect(watches.at(-1)).toEqual(["host-1", "session-1", false]);
  });

  it("disconnects the last watcher and rethrows non-gone post failures", async () => {
    const watches: Array<[string, string, boolean]> = [];
    const ctx = fixture();
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
      publicBaseUrl: origin,
      onSessionWatch: (hostId, sessionId, watching) => {
        watches.push([hostId, sessionId, watching]);
      },
    });
    await sockets.connect("viewer-1", "ticket", origin);
    ctx.sessions.set("session-1", {
      repositoryId: "repo-1",
      status: "running",
      hostId: "host-1",
    });
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    await expect(sockets.disconnect("viewer-1")).resolves.toBe(true);
    expect(watches).toEqual([
      ["host-1", "session-1", true],
      ["host-1", "session-1", false],
    ]);
    await sockets.connect("viewer-2", "ticket", origin);
    ctx.management.send.mockRejectedValueOnce(new Error("apigw down"));
    await expect(
      sockets.message(
        "viewer-2",
        JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
      ),
    ).rejects.toThrow("apigw down");
    await sockets.publishLog({
      sessionId: "session-1",
      timestampSeq: "2026-08-17T00:00:01.000Z#0000000001",
      seq: 1,
      stream: "stdout",
      content: "line",
      timestamp: "2026-08-17T00:00:01.000Z",
    });
  });

  it("keeps host watch while another viewer remains and skips non-client fan-out", async () => {
    const watches: Array<[string, string, boolean]> = [];
    const ctx = fixture();
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
      publicBaseUrl: origin,
      onSessionWatch: (hostId, sessionId, watching) => {
        watches.push([hostId, sessionId, watching]);
      },
    });
    await sockets.connect("viewer-1", "ticket", origin);
    await sockets.connect("viewer-2", "ticket", origin);
    ctx.sessions.set("session-1", {
      repositoryId: "repo-1",
      status: "running",
      hostId: "host-1",
    });
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    await sockets.message(
      "viewer-2",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    expect(watches).toEqual([["host-1", "session-1", true]]);
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:unsubscribe", sessionId: "session-1" }),
    );
    expect(watches).toEqual([["host-1", "session-1", true]]);
    const fanoutKey = `${VIEWER_FANOUT_PREFIX}session-1`;
    const fanout = ctx.connections.get(fanoutKey)!;
    ctx.connections.set(fanoutKey, {
      ...fanout,
      viewerFanoutIds: [...(fanout.viewerFanoutIds ?? []), "host-conn"],
    });
    ctx.connections.set("host-conn", {
      connectionId: "host-conn",
      type: "host",
      hostId: "host-1",
      connectedAt: "now",
      lastHeartbeatAt: "now",
    });
    const before = ctx.sent.length;
    await sockets.publishLogPart({
      sessionId: "session-1",
      key: "sessions/session-1/parts/9-9.jsonl.gz",
      seqStart: 9,
      seqEnd: 9,
    });
    expect(ctx.sent.length).toBeGreaterThan(before);
    ctx.management.send.mockRejectedValueOnce(
      new GoneException({ message: "gone", $metadata: {} }),
    );
    await sockets.publishLogPart({
      sessionId: "session-1",
      key: "sessions/session-1/parts/10-10.jsonl.gz",
      seqStart: 10,
      seqEnd: 10,
    });
    expect(watches.at(-1)).toEqual(["host-1", "session-1", true]);
  });

  it("does not unwatch a session that has no host on last unsubscribe or disconnect", async () => {
    const watches: Array<[string, string, boolean]> = [];
    const ctx = fixture();
    const sockets = createLambdaViewerSockets({
      auth: ctx.auth as never,
      management: ctx.management as never,
      storage: ctx.storage,
      publicBaseUrl: origin,
      onSessionWatch: (hostId, sessionId, watching) => {
        watches.push([hostId, sessionId, watching]);
      },
    });
    await sockets.connect("viewer-1", "ticket", origin);
    ctx.sessions.set("session-1", { repositoryId: "repo-1", status: "running" });
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    expect(watches).toEqual([]);
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:unsubscribe", sessionId: "session-1" }),
    );
    expect(watches).toEqual([]);
    await sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    await expect(sockets.disconnect("viewer-1")).resolves.toBe(true);
    expect(watches).toEqual([]);
    await sockets.connect("viewer-2", "ticket", origin);
    await sockets.message(
      "viewer-2",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    ctx.management.send.mockRejectedValueOnce(
      new GoneException({ message: "gone", $metadata: {} }),
    );
    await sockets.publishLogPart({
      sessionId: "session-1",
      key: "sessions/session-1/parts/11-11.jsonl.gz",
      seqStart: 11,
      seqEnd: 11,
    });
    expect(watches).toEqual([]);
    const sparse = fixture();
    await sparse.sockets.connect("viewer-sparse", "ticket", origin);
    delete sparse.connections.get("viewer-sparse")!.viewerSubscriptions;
    await expect(sparse.sockets.disconnect("viewer-sparse")).resolves.toBe(true);
    await sockets.connect("viewer-4", "ticket", origin);
    ctx.sessions.set("session-2", {
      repositoryId: "repo-1",
      status: "running",
      hostId: "host-2",
    });
    await sockets.message(
      "viewer-4",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-2" }),
    );
    await sockets.connect("viewer-5", "ticket", origin);
    await sockets.message(
      "viewer-5",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-2" }),
    );
    await expect(sockets.disconnect("viewer-4")).resolves.toBe(true);
    expect(ctx.connections.has("viewer-5")).toBe(true);
  });
});
