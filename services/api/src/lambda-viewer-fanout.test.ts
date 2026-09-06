import { describe, expect, it } from "vitest";

import type { ConnectionRecord } from "./db/plane-storage-types.ts";
import {
  addViewerFanout,
  removeViewerFanout,
  VIEWER_FANOUT_PREFIX,
  viewerConnectionIds,
} from "./lambda-viewer-fanout.ts";

function client(id: string, sessionId?: string): ConnectionRecord {
  return {
    connectionId: id,
    type: "client",
    hostId: "user:1",
    connectedAt: "t",
    lastHeartbeatAt: "t",
    ...(sessionId
      ? { viewerSubscriptions: [{ sessionId, repositoryId: "repo", status: "running" }] }
      : {}),
  };
}

describe("viewer fanout index", () => {
  it("indexes viewers by session and falls back to client subscriptions", async () => {
    const connections = new Map<string, ConnectionRecord>();
    const storage = {
      deleteConnection: async (id: string) => void connections.delete(id),
      getConnection: async (id: string) => connections.get(id) ?? null,
      listConnections: async () => [...connections.values()],
      putConnection: async (connection: ConnectionRecord) => {
        connections.set(connection.connectionId, connection);
      },
    };
    connections.set("viewer-1", client("viewer-1", "session-1"));
    connections.set("host-1", { ...client("host-1"), type: "host", hostId: "host-1" });
    await expect(viewerConnectionIds(storage, "session-1")).resolves.toEqual(["viewer-1"]);

    await addViewerFanout(storage, "session-1", "viewer-2");
    expect(connections.get(`${VIEWER_FANOUT_PREFIX}session-1`)?.viewerFanoutIds).toEqual([
      "viewer-2",
    ]);
    await expect(viewerConnectionIds(storage, "session-1")).resolves.toEqual(["viewer-2"]);

    await addViewerFanout(storage, "session-1", "viewer-2");
    await addViewerFanout(storage, "session-1", "viewer-3");
    await removeViewerFanout(storage, "session-1", "viewer-2");
    expect(connections.get(`${VIEWER_FANOUT_PREFIX}session-1`)?.viewerFanoutIds).toEqual([
      "viewer-3",
    ]);
    await removeViewerFanout(storage, "session-1", "viewer-3");
    expect(connections.has(`${VIEWER_FANOUT_PREFIX}session-1`)).toBe(false);
    await removeViewerFanout(storage, "missing", "viewer-2");
  });
});
