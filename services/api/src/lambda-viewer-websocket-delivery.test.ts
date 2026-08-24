import { describe, expect, it, vi } from "vitest";

import type { ConnectionRecord, LogRecord } from "./db/plane-storage-types.ts";
import { createLambdaViewerSockets } from "./lambda-viewer-websocket.ts";

function fixture() {
  const connections = new Map<string, ConnectionRecord>();
  const sent: Record<string, unknown>[] = [];
  const management = {
    send: vi.fn(async (command: { input: { Data?: Uint8Array } }) => {
      sent.push(
        JSON.parse(Buffer.from(command.input.Data!).toString("utf8")) as Record<string, unknown>,
      );
      return {};
    }),
  };
  const storage = {
    deleteConnection: vi.fn(async (id: string) => void connections.delete(id)),
    getConnection: vi.fn(async (id: string) => connections.get(id) ?? null),
    getSession: vi.fn(async () => ({ repositoryId: "repo-1", status: "running" })),
    listConnections: vi.fn(async () => [...connections.values()]),
    putConnection: vi.fn(async (connection: ConnectionRecord) => {
      connections.set(connection.connectionId, structuredClone(connection));
    }),
    queryLogs: vi.fn(async () => []),
  };
  const auth = {
    authenticateViewerTicket: vi.fn(async () => ({
      id: "user:viewer",
      username: "viewer",
      role: "operator" as const,
      kind: "user" as const,
      allowedRepositoryIds: ["repo-1"],
    })),
  };
  return {
    connections,
    management,
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

describe("Lambda viewer WebSocket delivery", () => {
  it("fans committed logs out to current durable viewer subscriptions", async () => {
    const ctx = fixture();
    await ctx.sockets.connect("viewer-1", "ticket", "https://app.example.test");
    const viewer = ctx.connections.get("viewer-1")!;
    viewer.viewerSubscriptions = [
      {
        sessionId: "session-1",
        repositoryId: "repo-1",
        status: "running",
        after: "2026-08-17T00:00:01.000Z#0000000001",
      },
    ];
    ctx.connections.set("viewer-1", viewer);
    ctx.connections.set("viewer-2", {
      ...viewer,
      connectionId: "viewer-2",
      viewerSubscriptions: [],
    });
    ctx.connections.set("host-1", { ...viewer, connectionId: "host-1", type: "host" });

    await ctx.sockets.publishLog(log("2026-08-17T00:00:01.000Z#0000000001", 1));
    expect(ctx.sent).toHaveLength(0);
    await ctx.sockets.publishLog(log("2026-08-17T00:00:02.000Z#0000000002", 2));
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.connections.get("viewer-1")?.viewerSubscriptions?.[0]?.after).toContain(
      "0000000002",
    );
  });

  it("removes gone viewers and propagates other delivery failures", async () => {
    const ctx = fixture();
    await ctx.sockets.connect("viewer-1", "ticket", "https://app.example.test");
    ctx.management.send.mockRejectedValueOnce({ name: "GoneException" });
    await ctx.sockets.message(
      "viewer-1",
      JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
    );
    expect(ctx.connections.has("viewer-1")).toBe(false);
    expect(ctx.storage.deleteConnection).toHaveBeenCalledWith("viewer-1");

    await ctx.sockets.connect("viewer-1", "ticket", "https://app.example.test");
    ctx.management.send.mockRejectedValueOnce(new Error("network"));
    await expect(
      ctx.sockets.message(
        "viewer-1",
        JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
      ),
    ).rejects.toThrow("network");
  });
});
