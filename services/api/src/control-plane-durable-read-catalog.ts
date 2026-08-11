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
export const listRepositoriesDurable = (state: ControlPlaneState) =>
  list<RepositoryRecord>(
    state,
    state.repositories,
    (storage) => storage.listRepositories(),
    (record) => record.id,
  );

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
export const listHostInventoriesDurable = (state: ControlPlaneState) =>
  list<HostInventoryRecord>(
    state,
    state.hostInventories,
    (storage) => storage.listHostInventories(),
    (record) => record.hostId,
  );

/** Refresh only the catalog tables used by target resolution, never the whole control plane. */
export async function refreshTargetCatalogDurable(state: ControlPlaneState): Promise<void> {
  await Promise.all([
    listCommandsDurable(state),
    listProvidersDurable(state),
    listProviderAccountsDurable(state),
  ]);
}
