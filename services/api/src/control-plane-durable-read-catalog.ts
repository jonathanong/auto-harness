import type {
  CommandRecord,
  DynamoPlaneStorage,
  HostInventoryRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./db/plane-storage.ts";
import type { ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

/** Read queue rows directly for operational metrics instead of reusing stale cache entries. */
export async function listQueuedSessionsDurableForMetric(
  state: ControlPlaneState,
): Promise<SessionRecord[]> {
  if (!state.storage)
    return [...state.sessions.values()].filter((session) => session.status === "queued");
  const candidates = (
    await Promise.all(
      [...Array(state.shardCount).keys()].map((shard) =>
        state.storage!.listSessionsByStatus("queued", shard),
      ),
    )
  ).flat();
  // The status GSI can retain deleted/transitioned candidates. Read each candidate's
  // base row consistently before it contributes to the operational queue-age metric.
  const durable = await Promise.all(
    candidates.map((candidate) => state.storage!.getSession(candidate.id, true)),
  );
  return durable.filter((session): session is SessionRecord => session?.status === "queued");
}

type CatalogMap<T> = Map<string, T>;

function replace<T>(map: CatalogMap<T>, records: readonly T[], id: (record: T) => string): T[] {
  map.clear();
  for (const record of records) map.set(id(record), { ...record });
  return [...map.values()];
}

async function get<T>(
  state: ControlPlaneState,
  map: CatalogMap<T>,
  read: (storage: DynamoPlaneStorage, id: string) => Promise<T | null>,
  id: string,
): Promise<T | null> {
  if (!state.storage) return map.get(id) ? { ...map.get(id)! } : null;
  const record = await read(state.storage, id);
  if (record) map.set(id, { ...record });
  else map.delete(id);
  return record ? { ...record } : null;
}

async function list<T>(
  state: ControlPlaneState,
  map: CatalogMap<T>,
  read: (storage: DynamoPlaneStorage) => Promise<T[]>,
  id: (record: T) => string,
): Promise<T[]> {
  if (!state.storage) return [...map.values()].map((record) => ({ ...record }));
  return replace(map, await read(state.storage), id);
}

export const getRepositoryDurable = (state: ControlPlaneState, id: string) =>
  get<RepositoryRecord>(
    state,
    state.repositories,
    (storage, recordId) => storage.getRepository(recordId),
    id,
  );
export async function listRepositoriesDurable(
  state: ControlPlaneState,
): Promise<RepositoryRecord[]> {
  if (!state.storage) {
    return [...state.repositories.values()].map((record) => ({ ...record }));
  }
  // A scan that started before a durable admission transition can finish afterward and
  // otherwise restore its stale admission state in the cache. Retry after local mutations.
  for (;;) {
    const revision = state.repositoryRevision;
    const records = await state.storage.listRepositories();
    if (revision === state.repositoryRevision) {
      return replace(state.repositories, records, (record) => record.id);
    }
  }
}

export const getScheduleDurable = (state: ControlPlaneState, id: string) =>
  get<ScheduleRecord>(
    state,
    state.schedules,
    (storage, recordId) => storage.getSchedule(recordId),
    id,
  );
export const listSchedulesDurable = (state: ControlPlaneState) =>
  list<ScheduleRecord>(
    state,
    state.schedules,
    (storage) => storage.listSchedules(),
    (record) => record.id,
  );

export const getCommandDurable = (state: ControlPlaneState, id: string) =>
  get<CommandRecord>(
    state,
    state.commands,
    (storage, recordId) => storage.getCommand(recordId),
    id,
  );
export const listCommandsDurable = (state: ControlPlaneState) =>
  list<CommandRecord>(
    state,
    state.commands,
    (storage) => storage.listCommands(),
    (record) => record.id,
  );

export const getProviderDurable = (state: ControlPlaneState, id: string) =>
  get<ProviderRecord>(
    state,
    state.providers,
    (storage, recordId) => storage.getProvider(recordId),
    id,
  );
export const listProvidersDurable = (state: ControlPlaneState) =>
  list<ProviderRecord>(
    state,
    state.providers,
    (storage) => storage.listProviders(),
    (record) => record.id,
  );

export const getProviderAccountDurable = (state: ControlPlaneState, id: string) =>
  get<ProviderAccountRecord>(
    state,
    state.providerAccounts,
    (storage, recordId) => storage.getProviderAccount(recordId),
    id,
  );
export const listProviderAccountsDurable = (state: ControlPlaneState) =>
  list<ProviderAccountRecord>(
    state,
    state.providerAccounts,
    (storage) => storage.listProviderAccounts(),
    (record) => record.id,
  );

export const getHostInventoryDurable = (state: ControlPlaneState, hostId: string) =>
  get<HostInventoryRecord>(
    state,
    state.hostInventories,
    (storage, id) => storage.getHostInventory(id),
    hostId,
  );
export async function listHostInventoriesDurable(
  state: ControlPlaneState,
): Promise<HostInventoryRecord[]> {
  if (!state.storage) {
    return [...state.hostInventories.values()].map((record) => ({ ...record }));
  }
  // A scan that started before a concurrent durable PUT can finish afterward and
  // otherwise erase the newer cache entry. Retry against storage after mutations.
  for (;;) {
    const revision = state.hostInventoryRevision;
    const records = await state.storage.listHostInventories();
    if (revision === state.hostInventoryRevision) {
      return replace(state.hostInventories, records, (record) => record.hostId);
    }
  }
}

/** Refresh only the catalog tables used by target resolution, never the whole control plane. */
export async function refreshTargetCatalogDurable(state: ControlPlaneState): Promise<void> {
  await Promise.all([
    listCommandsDurable(state),
    listProvidersDurable(state),
    listProviderAccountsDurable(state),
  ]);
}
