import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { ConnectionRecord } from "./control-plane-types.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import {
  deleteViewerConnection,
  filterUserSessionsForPrincipal,
  listUserSessions,
  listUserSessionsDurable,
  presentUserSessions,
  putViewerConnection,
} from "./control-plane-user-sessions.ts";

const viewer = {
  connectionId: "viewer-b",
  type: "client" as const,
  hostId: "user:bob",
  connectedAt: "2026-01-01T00:00:02.000Z",
  lastHeartbeatAt: "2026-01-01T00:00:02.000Z",
  viewerPrincipal: {
    id: "user:bob",
    username: "bob",
    role: "operator" as const,
    kind: "user" as const,
  },
  viewerSubscriptions: [
    { sessionId: "session-2", repositoryId: "repo-private", status: "running" },
  ],
};

const alice = {
  connectionId: "viewer-a",
  type: "client" as const,
  hostId: "user:alice",
  connectedAt: "2026-01-01T00:00:01.000Z",
  lastHeartbeatAt: "2026-01-01T00:00:01.000Z",
  viewerPrincipal: {
    id: "user:alice",
    username: "alice",
    role: "read-only" as const,
    kind: "user" as const,
  },
  viewerSubscriptions: [{ sessionId: "session-1", repositoryId: "repo-public", status: "queued" }],
};

describe("user session listing", () => {
  it("lists browser viewer sockets and omits host daemons", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:02.000Z" });
    plane.registerHost({ hostId: "mac-studio", worktrees: [] });
    plane.state.connections.set(alice.connectionId, alice);
    plane.state.connections.set(viewer.connectionId, viewer);
    expect(plane.listHosts().map((host) => host.hostId)).toEqual(["mac-studio"]);
    expect(listUserSessions(plane.state)).toEqual([
      expect.objectContaining({
        id: "viewer-a",
        userId: "user:alice",
        username: "alice",
        role: "read-only",
        subscriptions: [{ sessionId: "session-1", repositoryId: "repo-public", status: "queued" }],
      }),
      expect.objectContaining({ id: "viewer-b", username: "bob" }),
    ]);
  });

  it("reads durable viewer sockets from storage instead of the host connection cache", async () => {
    const state = createControlPlaneState({
      now: () => "2026-01-01T00:00:01.000Z",
      storage: {
        listConnections: async () => [
          {
            connectionId: "host",
            type: "host",
            hostId: "mac-studio",
            connectedAt: "t",
            lastHeartbeatAt: "t",
          },
          alice,
        ],
      } as never,
    });
    await expect(listUserSessionsDurable(state)).resolves.toEqual([
      expect.objectContaining({ id: "viewer-a", username: "alice" }),
    ]);
  });

  it("falls back to the in-memory map when storage cannot list sockets", async () => {
    const state = createControlPlaneState({ now: () => "2026-01-01T00:00:01.000Z" });
    state.connections.set(alice.connectionId, alice);
    await expect(listUserSessionsDurable(state)).resolves.toEqual([
      expect.objectContaining({ id: "viewer-a" }),
    ]);
  });

  it("omits viewer fanout index rows from the live user-session list", () => {
    expect(
      presentUserSessions([
        alice,
        {
          connectionId: "viewers#session-1",
          type: "client",
          hostId: "fanout",
          connectedAt: "t",
          lastHeartbeatAt: "t",
          viewerFanoutIds: ["viewer-a"],
        },
      ]).map((item) => item.id),
    ).toEqual(["viewer-a"]);
  });

  it("presents an anonymous viewer when no principal was recorded", () => {
    expect(
      presentUserSessions([
        {
          connectionId: "anon",
          type: "client",
          hostId: "anonymous",
          connectedAt: "t",
          lastHeartbeatAt: "t",
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: "anon",
        userId: "anonymous",
        username: "anonymous",
        role: null,
        kind: "user",
        subscriptions: [],
      }),
    ]);
  });

  it("hides other viewers from repository-scoped and host-bound principals", () => {
    const items = presentUserSessions([alice, viewer]);
    expect(
      filterUserSessionsForPrincipal(items, {
        id: "user:alice",
        allowedRepositoryIds: ["repo-public"],
      }).map((item) => item.id),
    ).toEqual(["viewer-a"]);
    expect(
      filterUserSessionsForPrincipal(items, {
        id: "user:carol",
        allowedRepositoryIds: ["repo-public"],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "viewer-a",
        subscriptions: [{ sessionId: "session-1", repositoryId: "repo-public", status: "queued" }],
      }),
    ]);
    expect(
      filterUserSessionsForPrincipal(items, { id: "service:host", boundHostId: "mac-studio" }),
    ).toEqual([]);
    expect(filterUserSessionsForPrincipal(items, { id: "user:admin" })).toHaveLength(2);
    expect(
      filterUserSessionsForPrincipal(
        presentUserSessions([{ ...viewer, viewerSubscriptions: [] }]),
        { id: "user:carol", allowedRepositoryIds: ["repo-public"] },
      ),
    ).toEqual([]);
  });

  it("persists and deletes viewer sockets when storage adapters exist", async () => {
    const put: ConnectionRecord[] = [];
    const removed: string[] = [];
    const state = createControlPlaneState({
      storage: {
        putConnection: async (connection: ConnectionRecord) => {
          put.push(connection);
        },
        deleteConnection: async (connectionId: string) => {
          removed.push(connectionId);
        },
      } as never,
    });
    putViewerConnection(state, alice);
    expect(state.connections.get("viewer-a")?.type).toBe("client");
    await state.writeTail;
    expect(put).toEqual([alice]);
    deleteViewerConnection(state, "viewer-a");
    expect(state.connections.has("viewer-a")).toBe(false);
    await state.writeTail;
    expect(removed).toEqual(["viewer-a"]);
  });
});
