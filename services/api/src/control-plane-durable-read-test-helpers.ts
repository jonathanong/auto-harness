import type { ControlPlaneState } from "./control-plane-state.ts";

/** Complete partial storage doubles with reads reflecting their owning state. */
export function addDurableReadDefaults(state: ControlPlaneState): void {
  if (!state.storage) return;
  const storage = state.storage as unknown as Record<string, unknown>;
  storage.getSession ??= async (id: string) => copy(state.sessions.get(id));
  storage.listAllSessions ??= async () => list(state.sessions);
  storage.listSessionDrains ??= async () => [];
  storage.listSessionsForDrain ??= async (
    repositoryId: string,
    principalId: string,
    operationId: string,
    _shardCount: number,
  ) =>
    list(state.sessions).filter((session) => {
      const owner = session.principalId ?? session.metadata?.createdBy;
      return (
        session.repositoryId === repositoryId &&
        owner === principalId &&
        (session.status === "queued" ||
          session.status === "running" ||
          (session.status === "cancelled" && session.cancelledByDrainOperationId === operationId))
      );
    });
  storage.listSessionsByStatus ??= async (status: string, shard: number) =>
    list(state.sessions).filter(
      (session) => session.status === status && session.queueShard === shard,
    );
  storage.listLogs ??= async (id: string) => [...(state.logs.get(id) ?? [])].map(copy);
  storage.listAllWorktrees ??= async () => list(state.worktrees);
  storage.listWorktreesForRepo ??= async (id: string) =>
    list(state.worktrees).filter((worktree) => worktree.repositoryId === id);
  storage.listConnections ??= async () => list(state.connections);
  storage.listRepositories ??= async () => list(state.repositories);
  storage.getRepository ??= async (id: string) => copy(state.repositories.get(id));
  storage.listSchedules ??= async () => list(state.schedules);
  storage.getSchedule ??= async (id: string) => copy(state.schedules.get(id));
  storage.listCommands ??= async () => list(state.commands);
  storage.getCommand ??= async (id: string) => copy(state.commands.get(id));
  storage.listProviders ??= async () => list(state.providers);
  storage.getProvider ??= async (id: string) => copy(state.providers.get(id));
  storage.listProviderAccounts ??= async () => list(state.providerAccounts);
  storage.getProviderAccount ??= async (id: string) => copy(state.providerAccounts.get(id));
  storage.listHostInventories ??= async () => list(state.hostInventories);
  storage.getHostInventory ??= async (id: string) => copy(state.hostInventories.get(id));
  storage.putAuditLog ??= async () => undefined;
  storage.listAuditLogs ??= async () => ({ items: [] });
  storage.listAllAuditLogs ??= async () => [];
}

/** Install a partial storage double together with all typed durable reads. */
export function setDurableReadStorage(state: ControlPlaneState, storage: object): void {
  state.storage = storage as never;
  addDurableReadDefaults(state);
}

function copy<T extends object>(record: T | undefined): T | null {
  return record ? { ...record } : null;
}

function list<T extends object>(records: Map<string, T>): T[] {
  return [...records.values()].map((record) => ({ ...record }));
}
