import type { ControlPlaneState } from "./control-plane-state.ts";
import type { ConnectionRecord } from "./db/plane-storage-types.ts";

function installLiveConnection(state: ControlPlaneState, connection: ConnectionRecord): void {
  if (connection.type !== "host" || connection.registered === false) return;
  state.connections.set(connection.connectionId, { ...connection });
  state.hostConnection.set(connection.hostId, connection.connectionId);
}

/** Load one live host socket so event-driven assign can see the sender. */
export async function hydrateAssignmentConnectionDurable(
  state: ControlPlaneState,
  connectionId: string,
): Promise<void> {
  const storage = state.storage;
  if (!storage || typeof storage.getConnection !== "function") return;
  const connection = await storage.getConnection(connectionId);
  if (connection) installLiveConnection(state, connection);
}

/** Refresh a bounded set of live advertisements and fail closed for the rest. */
export async function refreshAssignmentReadinessDurable(
  state: ControlPlaneState,
  maxHosts: number,
): Promise<void> {
  const storage = state.storage;
  if (!storage || maxHosts <= 0 || typeof storage.getConnection !== "function") return;
  let connectionIds = [...state.connections.keys()].slice(0, maxHosts);
  if (connectionIds.length === 0 && typeof storage.listConnections === "function") {
    connectionIds = (await storage.listConnections())
      .filter((connection) => connection.type === "host" && connection.registered !== false)
      .slice(0, maxHosts)
      .map((connection) => connection.connectionId);
  }
  const refreshed = new Set(connectionIds);
  for (const [connectionId, connection] of state.connections) {
    if (!refreshed.has(connectionId) && connection.providerAccountReadiness) {
      state.connections.set(connectionId, { ...connection, providerAccountReadiness: [] });
    }
  }
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const connection = await storage.getConnection(connectionId);
      if (connection && connection.registered !== false) {
        installLiveConnection(state, connection);
        return;
      }
      for (const [hostId, current] of state.hostConnection) {
        if (current === connectionId) state.hostConnection.delete(hostId);
      }
      state.connections.delete(connectionId);
    }),
  );
}
