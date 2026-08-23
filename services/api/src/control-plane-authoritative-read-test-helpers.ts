import type {
  CommandRecord,
  HostInventoryRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./db/plane-storage.ts";
import type {
  ArchiveMetadata,
  LogQuery,
  LogRecord,
  ScheduleRecord,
} from "./control-plane-types.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { selectLogs } from "./log-query.ts";

function copy<T extends object>(records: Map<string, T>, id: string): T | null {
  const record = records.get(id);
  return record ? { ...record } : null;
}

function list<T extends object>(records: Map<string, T>): T[] {
  return [...records.values()].map((record) => ({ ...record }));
}

/** Minimal shared storage double for cross-control-plane authoritative-read tests. */
export function createAuthoritativeReadStorage() {
  const repositories = new Map<string, RepositoryRecord>();
  const schedules = new Map<string, ScheduleRecord>();
  const commands = new Map<string, CommandRecord>();
  const providers = new Map<string, ProviderRecord>();
  const accounts = new Map<string, ProviderAccountRecord>();
  const inventories = new Map<string, HostInventoryRecord>();
  const sessions = new Map<string, SessionRecord>();
  const logs = new Map<string, LogRecord[]>();
  const worktrees = new Map<string, WorktreeRecord>();
  const archives = new Map<string, ArchiveMetadata>();
  const storage = {
    putAuditLog: async () => undefined,
    listAuditLogs: async () => ({ items: [] }),
    listAllAuditLogs: async () => [],
    putRepository: async (record: RepositoryRecord) => repositories.set(record.id, { ...record }),
    updateRepositorySettings: async (
      id: string,
      patch: Partial<RepositoryRecord>,
      updatedAt: string,
    ) => {
      const current = repositories.get(id);
      if (!current) return null;
      const updated = { ...current, ...patch, updatedAt };
      repositories.set(id, updated);
      return { ...updated };
    },
    getRepository: async (id: string) => copy(repositories, id),
    listRepositories: async () => list(repositories),
    deleteRepository: async (id: string) => repositories.delete(id),
    putSchedule: async (record: ScheduleRecord) => schedules.set(record.id, { ...record }),
    getSchedule: async (id: string) => copy(schedules, id),
    listSchedules: async () => list(schedules),
    deleteSchedule: async (id: string) => schedules.delete(id),
    putCommand: async (record: CommandRecord) => commands.set(record.id, { ...record }),
    getCommand: async (id: string) => copy(commands, id),
    listCommands: async () => list(commands),
    deleteCommand: async (id: string) => commands.delete(id),
    putProvider: async (record: ProviderRecord) => providers.set(record.id, { ...record }),
    getProvider: async (id: string) => copy(providers, id),
    listProviders: async () => list(providers),
    deleteProvider: async (id: string) => providers.delete(id),
    putProviderAccount: async (record: ProviderAccountRecord) =>
      accounts.set(record.id, { ...record }),
    getProviderAccount: async (id: string) => copy(accounts, id),
    listProviderAccounts: async () => list(accounts),
    deleteProviderAccount: async (id: string) => accounts.delete(id),
    putHostInventory: async (record: HostInventoryRecord) =>
      inventories.set(record.hostId, { ...record }),
    getHostInventory: async (id: string) => copy(inventories, id),
    listHostInventories: async () => list(inventories),
    deleteHostInventory: async (id: string) => inventories.delete(id),
    createSession: async (record: SessionRecord) => {
      sessions.set(record.id, { ...record });
      return { created: true, session: record };
    },
    getSession: async (id: string) => copy(sessions, id),
    listAllSessions: async () => list(sessions),
    listSessionsByStatus: async (status: string, shard: number) =>
      list(sessions).filter((record) => record.status === status && record.queueShard === shard),
    putLog: async (record: LogRecord) =>
      logs.set(record.sessionId, [...(logs.get(record.sessionId) ?? []), { ...record }]),
    listLogs: async (id: string) => [...(logs.get(id) ?? [])].map((record) => ({ ...record })),
    queryLogs: async (id: string, query: LogQuery) => selectLogs(logs.get(id) ?? [], query),
    putWorktree: async (record: WorktreeRecord) => worktrees.set(record.id, { ...record }),
    deleteWorktree: async (id: string) => worktrees.delete(id),
    listAllWorktrees: async () => list(worktrees),
    listWorktreesForRepo: async (id: string) =>
      list(worktrees).filter((record) => record.repositoryId === id),
    listConnections: async () => [],
    putArchive: async (record: ArchiveMetadata) => archives.set(record.key, { ...record }),
    getArchive: async (key: string) => copy(archives, key),
    listArchives: async () => list(archives),
    tryClaimScheduleAndCreateSession: async ({
      scheduleId,
      expectedNextRunAt,
      newNextRunAt,
      lastRunAt,
      session,
    }: {
      scheduleId: string;
      expectedNextRunAt: string;
      newNextRunAt: string;
      lastRunAt: string;
      session: SessionRecord;
    }) => {
      const schedule = schedules.get(scheduleId);
      if (!schedule || !schedule.enabled || schedule.nextRunAt !== expectedNextRunAt)
        return { kind: "lost" };
      schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt, lastRunAt });
      sessions.set(session.id, { ...session });
      return { kind: "created" };
    },
  };
  return storage as never;
}
