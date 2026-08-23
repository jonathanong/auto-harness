/* eslint-disable max-lines -- durable storage defaults stay centralized for consistent test semantics. */
import type { ControlPlaneState } from "./control-plane-state.ts";
import type { AuditLogRecord } from "./audit-types.ts";
import type { ScheduleRecord } from "./control-plane-types.ts";
import type { SessionRecord } from "./db/types.ts";

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
  storage.disableLegacyFallbackScheduleAndAudit ??= async ({
    scheduleId,
    expectedNextRunAt,
  }: {
    scheduleId: string;
    expectedNextRunAt: string;
    audit: AuditLogRecord;
  }) => {
    const schedule = state.schedules.get(scheduleId);
    if (!schedule || !schedule.enabled || schedule.nextRunAt !== expectedNextRunAt) return false;
    state.schedules.set(scheduleId, { ...schedule, enabled: false });
    return true;
  };
}

/** Install a partial storage double together with all typed durable reads. */
export function setDurableReadStorage(state: ControlPlaneState, storage: object): void {
  state.storage = storage as never;
  addDurableReadDefaults(state);
}

/**
 * Focused in-memory schedule store for durable schedule route/fire tests.
 * It keeps the storage and control-plane cache coherent without pretending to
 * model unrelated DynamoDB tables.
 */
export function setInMemoryScheduleStorage(
  state: ControlPlaneState,
  overrides: Record<string, unknown> = {},
): void {
  const storage = {
    putSchedule: async (record: ScheduleRecord) => {
      state.schedules.set(record.id, { ...record });
    },
    updateScheduleManagement: async (record: ScheduleRecord, expectedNextRunAt: string) => {
      const current = state.schedules.get(record.id);
      if (!current || current.nextRunAt !== expectedNextRunAt) return null;
      state.schedules.set(record.id, { ...record });
      return { ...record };
    },
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
      const schedule = state.schedules.get(scheduleId);
      if (!schedule || !schedule.enabled || schedule.nextRunAt !== expectedNextRunAt) {
        return { kind: "lost" };
      }
      state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt, lastRunAt });
      state.sessions.set(session.id, { ...session });
      return { kind: "created" };
    },
    skipScheduleForClosedRepository: async ({
      scheduleId,
      repositoryId,
      expectedNextRunAt,
      newNextRunAt,
    }: {
      scheduleId: string;
      repositoryId: string;
      expectedNextRunAt: string;
      newNextRunAt: string;
    }) => {
      const schedule = state.schedules.get(scheduleId);
      const repository = state.repositories.get(repositoryId);
      if (
        !schedule ||
        !repository ||
        repository.admissionState === "active" ||
        !schedule.enabled ||
        schedule.repositoryId !== repositoryId ||
        schedule.nextRunAt !== expectedNextRunAt
      ) {
        return false;
      }
      state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt });
      return true;
    },
    skipScheduleBeforeActivationCutoff: async ({
      scheduleId,
      repositoryId,
      activationCutoffAt,
      expectedNextRunAt,
      newNextRunAt,
    }: {
      scheduleId: string;
      repositoryId: string;
      activationCutoffAt: string;
      expectedNextRunAt: string;
      newNextRunAt: string;
    }) => {
      const schedule = state.schedules.get(scheduleId);
      const repository = state.repositories.get(repositoryId);
      if (
        !schedule ||
        !schedule.enabled ||
        schedule.repositoryId !== repositoryId ||
        schedule.nextRunAt !== expectedNextRunAt ||
        Date.parse(expectedNextRunAt) >= Date.parse(activationCutoffAt) ||
        repository?.admissionState !== "active" ||
        repository.activationCutoffAt !== activationCutoffAt
      ) {
        return false;
      }
      state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt });
      return true;
    },
    skipOwnerlessScheduleAndAudit: async ({
      scheduleId,
      expectedNextRunAt,
      newNextRunAt,
      lastRunAt,
    }: {
      scheduleId: string;
      expectedNextRunAt: string;
      newNextRunAt: string;
      lastRunAt: string;
      audit: AuditLogRecord;
    }) => {
      const schedule = state.schedules.get(scheduleId);
      if (
        !schedule ||
        !schedule.enabled ||
        schedule.principalId !== undefined ||
        schedule.nextRunAt !== expectedNextRunAt
      ) {
        return false;
      }
      state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt, lastRunAt });
      return true;
    },
    disableLegacyFallbackScheduleAndAudit: async ({
      scheduleId,
      expectedNextRunAt,
    }: {
      scheduleId: string;
      expectedNextRunAt: string;
      audit: AuditLogRecord;
    }) => {
      const schedule = state.schedules.get(scheduleId);
      if (!schedule || !schedule.enabled || schedule.nextRunAt !== expectedNextRunAt) {
        return false;
      }
      state.schedules.set(scheduleId, { ...schedule, enabled: false });
      return true;
    },
    skipScheduleForPrincipalDrainAndAudit: async () => false,
    putAuditLog: async (record: AuditLogRecord) => {
      state.auditLogs.set(record.id, { ...record });
    },
    ...overrides,
  };
  setDurableReadStorage(state, storage);
}

function copy<T extends object>(record: T | undefined): T | null {
  return record ? { ...record } : null;
}

function list<T extends object>(records: Map<string, T>): T[] {
  return [...records.values()].map((record) => ({ ...record }));
}
