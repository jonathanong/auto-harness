import type { LogQuery, LogRecord } from "./control-plane-types.ts";
import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { selectLogs } from "./log-query.ts";
import {
  listHostInventoriesDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";

export async function getSessionDurable(
  state: ControlPlaneState,
  id: string,
): Promise<SessionRecord | null> {
  if (!state.storage) return state.sessions.get(id) ? { ...state.sessions.get(id)! } : null;
  const session = await state.storage.getSession(id, true);
  if (session) state.sessions.set(id, { ...session });
  else state.sessions.delete(id);
  return session ? { ...session } : null;
}

export async function listSessionsDurable(state: ControlPlaneState): Promise<SessionRecord[]> {
  if (!state.storage) return [...state.sessions.values()].map((session) => ({ ...session }));
  const sessions = await state.storage.listAllSessions();
  state.sessions.clear();
  for (const session of sessions) state.sessions.set(session.id, { ...session });
  return sessions.map((session) => ({ ...session }));
}

export async function listSessionsForRepositoriesDurable(
  state: ControlPlaneState,
  repositoryIds: readonly string[],
): Promise<SessionRecord[]> {
  if (!state.storage) {
    const allowed = new Set(repositoryIds);
    return [...state.sessions.values()].filter((session) => allowed.has(session.repositoryId));
  }
  const pages = await Promise.all(
    repositoryIds.map((repositoryId) => state.storage!.listSessionsByRepository(repositoryId)),
  );
  return pages.flat();
}

export async function listQueuedSessionsDurable(
  state: ControlPlaneState,
  type: SessionRecord["type"],
): Promise<SessionRecord[]> {
  if (!state.storage) {
    return [...state.sessions.values()].filter(
      (session) => session.status === "queued" && session.type === type,
    );
  }
  const pages = await Promise.all(
    [...Array(state.shardCount).keys()].map((shard) =>
      state.storage!.listSessionsByStatus("queued", shard),
    ),
  );
  for (const [id, session] of state.sessions)
    if (session.status === "queued" && session.type === type) state.sessions.delete(id);
  const queued = pages.flat().filter((session) => session.type === type);
  for (const session of queued) state.sessions.set(session.id, { ...session });
  return queued;
}

export async function getLogsDurable(
  state: ControlPlaneState,
  sessionId: string,
  query?: LogQuery,
): Promise<LogRecord[]> {
  if (!state.storage) {
    const logs = [...(state.logs.get(sessionId) ?? [])];
    return query ? selectLogs(logs, query) : logs;
  }
  const logs = (
    await (query ? state.storage.queryLogs(sessionId, query) : state.storage.listLogs(sessionId))
  ).toSorted((a, b) => a.timestampSeq.localeCompare(b.timestampSeq));
  // A bounded request must not replace the cache with a partial history.
  if (!query)
    state.logs.set(
      sessionId,
      logs.map((log) => ({ ...log })),
    );
  return logs.map((log) => ({ ...log }));
}

export async function listWorktreesDurable(state: ControlPlaneState): Promise<WorktreeRecord[]> {
  if (!state.storage) return [...state.worktrees.values()].map((worktree) => ({ ...worktree }));
  const worktrees = await state.storage.listAllWorktrees(true);
  state.worktrees.clear();
  for (const worktree of worktrees) state.worktrees.set(worktree.id, { ...worktree });
  return worktrees;
}

export async function listWorktreesForRepositoryDurable(
  state: ControlPlaneState,
  repositoryId: string,
): Promise<WorktreeRecord[]> {
  if (!state.storage)
    return [...state.worktrees.values()].filter(
      (worktree) => worktree.repositoryId === repositoryId,
    );
  const worktrees = await state.storage.listWorktreesForRepo(repositoryId);
  for (const [id, worktree] of state.worktrees)
    if (worktree.repositoryId === repositoryId) state.worktrees.delete(id);
  for (const worktree of worktrees) state.worktrees.set(worktree.id, { ...worktree });
  return worktrees;
}

export async function refreshSchedulerReadModel(state: ControlPlaneState): Promise<void> {
  const storage: DynamoPlaneStorage | undefined = state.storage;
  if (!storage) {
    await Promise.all([refreshTargetCatalogDurable(state), listHostInventoriesDurable(state)]);
    return;
  }
  const previousDraining = new Set(state.drainingHosts);
  const [connections] = await Promise.all([
    storage.listConnections(),
    refreshTargetCatalogDurable(state),
    listHostInventoriesDurable(state),
  ]);
  state.connections.clear();
  state.hostConnection.clear();
  state.drainingHosts.clear();
  for (const connection of connections) {
    if (connection.registered === false) continue;
    state.connections.set(connection.connectionId, { ...connection });
    state.hostConnection.set(connection.hostId, connection.connectionId);
  }
  if (typeof storage.getHostLockState === "function") {
    const lockStates = await Promise.all(
      connections.map(async (connection) => ({
        hostId: connection.hostId,
        connectionId: connection.connectionId,
        lock: await storage.getHostLockState(connection.hostId),
      })),
    );
    for (const { hostId, connectionId, lock } of lockStates) {
      if (lock.connectionId === connectionId && lock.draining) state.drainingHosts.add(hostId);
    }
  } else {
    // Keep legacy storage doubles compatible; production Dynamo storage always exposes
    // getHostLockState, which is the authoritative drain read above.
    for (const connection of connections) {
      if (previousDraining.has(connection.hostId)) state.drainingHosts.add(connection.hostId);
    }
  }
}
