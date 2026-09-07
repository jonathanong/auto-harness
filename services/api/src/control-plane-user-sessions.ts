import type { ConnectionRecord } from "./db/plane-storage-types.ts";
import { queueWrite, type ControlPlaneState } from "./control-plane-state.ts";

export type UserSessionRecord = {
  id: string;
  userId: string;
  username: string;
  role: string | null;
  kind: "admin" | "user";
  connectedAt: string;
  lastHeartbeatAt: string;
  subscriptions: Array<{
    sessionId: string;
    repositoryId: string;
    status: string;
  }>;
};

type UserSessionPrincipal = {
  id: string;
  allowedRepositoryIds?: string[];
  boundHostId?: string;
};

function toUserSession(connection: ConnectionRecord): UserSessionRecord {
  const principal = connection.viewerPrincipal;
  return {
    id: connection.connectionId,
    userId: principal?.id ?? connection.hostId,
    username: principal?.username ?? "anonymous",
    role: principal?.role ?? null,
    kind: principal?.kind ?? "user",
    connectedAt: connection.connectedAt,
    lastHeartbeatAt: connection.lastHeartbeatAt,
    subscriptions: (connection.viewerSubscriptions ?? []).map((subscription) => ({
      sessionId: subscription.sessionId,
      repositoryId: subscription.repositoryId,
      status: subscription.status,
    })),
  };
}

export function presentUserSessions(connections: Iterable<ConnectionRecord>): UserSessionRecord[] {
  return [...connections]
    .filter(
      (connection) =>
        connection.type === "client" && !connection.connectionId.startsWith("viewers#"),
    )
    .map(toUserSession)
    .toSorted((a, b) => a.username.localeCompare(b.username) || a.id.localeCompare(b.id));
}

export function listUserSessions(state: ControlPlaneState): UserSessionRecord[] {
  return presentUserSessions(state.connections.values());
}

export async function listUserSessionsDurable(
  state: ControlPlaneState,
): Promise<UserSessionRecord[]> {
  const storage = state.storage;
  if (storage && typeof storage.listConnections === "function") {
    return presentUserSessions(await storage.listConnections());
  }
  return listUserSessions(state);
}

export function filterUserSessionsForPrincipal(
  items: UserSessionRecord[],
  principal: UserSessionPrincipal | null | undefined,
): UserSessionRecord[] {
  if (principal?.boundHostId) return [];
  if (!principal?.allowedRepositoryIds) return items;
  const allowed = new Set(principal.allowedRepositoryIds);
  return items.flatMap((item) => {
    if (item.userId === principal.id) return [item];
    const subscriptions = item.subscriptions.filter((subscription) =>
      allowed.has(subscription.repositoryId),
    );
    return subscriptions.length > 0 ? [{ ...item, subscriptions }] : [];
  });
}

export function putViewerConnection(state: ControlPlaneState, connection: ConnectionRecord): void {
  state.connections.set(connection.connectionId, { ...connection });
  queueWrite(state, async (storage) => {
    if (storage && typeof storage.putConnection === "function") {
      await storage.putConnection(connection);
    }
  });
}

export function deleteViewerConnection(state: ControlPlaneState, connectionId: string): void {
  state.connections.delete(connectionId);
  queueWrite(state, async (storage) => {
    if (storage && typeof storage.deleteConnection === "function") {
      await storage.deleteConnection(connectionId);
    }
  });
}
