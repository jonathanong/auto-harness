import type { ControlPlaneState } from "./control-plane-state.ts";

/** Refresh a bounded set of live advertisements and fail closed for the rest. */
export async function refreshAssignmentReadinessDurable(
  state: ControlPlaneState,
  maxHosts: number,
): Promise<void> {
  const storage = state.storage;
  if (!storage || maxHosts <= 0 || typeof storage.getConnection !== "function") return;
  const connectionIds = [...state.connections.keys()].slice(0, maxHosts);
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
        state.connections.set(connectionId, { ...connection });
        state.hostConnection.set(connection.hostId, connectionId);
        return;
      }
      for (const [hostId, current] of state.hostConnection) {
        if (current === connectionId) state.hostConnection.delete(hostId);
      }
      state.connections.delete(connectionId);
    }),
  );
}
