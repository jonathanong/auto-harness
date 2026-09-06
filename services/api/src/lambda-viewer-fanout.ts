import type { ConnectionRecord } from "./db/plane-storage-types.ts";

export const VIEWER_FANOUT_PREFIX = "viewers#";

export type ViewerFanoutStorage = {
  deleteConnection(connectionId: string): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  listConnections(): Promise<ConnectionRecord[]>;
  putConnection(connection: ConnectionRecord): Promise<void>;
};

function fanoutKey(sessionId: string): string {
  return `${VIEWER_FANOUT_PREFIX}${sessionId}`;
}

function fanoutIds(connection: ConnectionRecord | null): string[] {
  return connection?.viewerFanoutIds ?? [];
}

export async function viewerConnectionIds(
  storage: ViewerFanoutStorage,
  sessionId: string,
): Promise<string[]> {
  const indexed = fanoutIds(await storage.getConnection(fanoutKey(sessionId)));
  if (indexed.length > 0) return indexed;
  return (await storage.listConnections())
    .filter(
      (connection) =>
        connection.type === "client" &&
        !connection.connectionId.startsWith(VIEWER_FANOUT_PREFIX) &&
        connection.viewerSubscriptions?.some(
          (subscription) => subscription.sessionId === sessionId,
        ),
    )
    .map((connection) => connection.connectionId);
}

export async function addViewerFanout(
  storage: ViewerFanoutStorage,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  const key = fanoutKey(sessionId);
  const existing = await storage.getConnection(key);
  const ids = new Set(fanoutIds(existing));
  ids.add(connectionId);
  await storage.putConnection({
    connectionId: key,
    type: "client",
    hostId: "fanout",
    connectedAt: existing?.connectedAt ?? new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    viewerFanoutIds: [...ids],
  });
}

export async function removeViewerFanout(
  storage: ViewerFanoutStorage,
  sessionId: string,
  connectionId: string,
): Promise<void> {
  const key = fanoutKey(sessionId);
  const existing = await storage.getConnection(key);
  if (!existing) return;
  const ids = fanoutIds(existing).filter((id) => id !== connectionId);
  if (ids.length === 0) {
    await storage.deleteConnection(key);
    return;
  }
  await storage.putConnection({ ...existing, viewerFanoutIds: ids });
}
