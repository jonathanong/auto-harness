import { DEFAULT_MAX_CONCURRENT_SESSIONS, normalizeHostCapabilities } from "@auto-harness/shared";

import type {
  CommandRecord,
  DynamoPlaneStorage,
  HostInventoryRecord,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { hydrateScheduledState } from "./control-plane-hydrate-scheduled.ts";
import { backfillLegacyProviderAccountLeases } from "./control-plane-hydrate-provider-leases.ts";
import type {
  ArchiveMetadata,
  ConnectionRecord,
  LogRecord,
  ScheduleRecord,
} from "./control-plane-types.ts";
import type { AuditLogRecord } from "./audit-types.ts";
import type { UsageRecord } from "./usage.ts";
import type { SlackIntegrationRecord } from "./slack-integration-types.ts";

type HydratableState = {
  storage: DynamoPlaneStorage | undefined;
  sessions: Map<string, SessionRecord>;
  worktrees: Map<string, WorktreeRecord>;
  connections: Map<string, ConnectionRecord>;
  hostConnection: Map<string, string>;
  logs: Map<string, LogRecord[]>;
  schedules: Map<string, ScheduleRecord>;
  repositories: Map<string, RepositoryRecord>;
  hostInventories: Map<string, HostInventoryRecord>;
  providers: Map<string, ProviderRecord>;
  providerAccounts: Map<string, ProviderAccountRecord>;
  commands: Map<string, CommandRecord>;
  slackIntegration: SlackIntegrationRecord | undefined;
  auditLogs: Map<string, AuditLogRecord>;
  usageRecords: Map<string, UsageRecord>;
  archives: Map<string, ArchiveMetadata>;
  pendingAcks: { clear(): void };
  mainCheckoutLeases: Map<string, { sessionId: string; connectionId: string }>;
  providerAccountLeases: Map<
    string,
    {
      sessionId: string;
      attemptId: string;
      slot: number;
      hostId: string;
      providerAccountId: string;
    }
  >;
  drainingHosts: Set<string>;
  disconnectedHosts: Map<string, { lastHeartbeatAt: string }>;
};

/** Restore the complete durable snapshot before making it visible to callers. */
export async function hydrateFromStorage(state: HydratableState): Promise<void> {
  if (!state.storage) return;
  // Legacy storage fakes and adapters can still hydrate their pre-usage
  // snapshot. Production Dynamo storage always implements this additive read.
  const listUsageRecords =
    typeof state.storage.listUsageRecords === "function"
      ? state.storage.listUsageRecords()
      : Promise.resolve([] as UsageRecord[]);
  const [
    sessions,
    worktrees,
    connections,
    schedules,
    repositories,
    inventories,
    providers,
    accounts,
    commands,
    archives,
    auditLogs,
    usageRecords,
    slackIntegration,
  ] = await Promise.all([
    state.storage.listAllSessions(),
    state.storage.listAllWorktrees(),
    state.storage.listConnections(),
    state.storage.listSchedules(),
    state.storage.listRepositories(),
    state.storage.listHostInventories(),
    state.storage.listProviders(),
    state.storage.listProviderAccounts(),
    state.storage.listCommands(),
    state.storage.listArchives(),
    state.storage.listAllAuditLogs(),
    listUsageRecords,
    "getSlackIntegration" in state.storage
      ? state.storage.getSlackIntegration()
      : Promise.resolve(null),
  ]);
  const logs = new Map<string, LogRecord[]>();
  for (const session of sessions) {
    logs.set(
      session.id,
      (await state.storage.listLogs(session.id)).toSorted((a, b) =>
        a.timestampSeq.localeCompare(b.timestampSeq),
      ),
    );
  }

  state.worktrees.clear();
  state.connections.clear();
  state.hostConnection.clear();
  state.logs.clear();
  state.schedules.clear();
  state.repositories.clear();
  state.hostInventories.clear();
  state.providers.clear();
  state.providerAccounts.clear();
  state.commands.clear();
  state.slackIntegration = undefined;
  state.auditLogs.clear();
  state.usageRecords.clear();
  state.archives.clear();
  state.drainingHosts.clear();
  state.disconnectedHosts.clear();
  state.providerAccountLeases.clear();
  for (const record of providers) state.providers.set(record.id, record);
  for (const record of accounts) {
    state.providerAccounts.set(record.id, {
      ...record,
      maxConcurrentSessions: record.maxConcurrentSessions ?? DEFAULT_MAX_CONCURRENT_SESSIONS,
    });
  }
  // providers/providerAccounts must be populated before the backfill below,
  // which caps each candidate's slot search by the account's configured
  // maxConcurrentSessions (see control-plane-hydrate-provider-leases.ts).
  await backfillLegacyProviderAccountLeases(state, sessions);
  hydrateScheduledState(state, sessions);
  for (const session of sessions) {
    const lease = session.providerAccountLease;
    // Cancelled running work retains the assignment until the daemon reports
    // terminal; queued leftover lease fields must not occupy a slot.
    if (
      !lease ||
      (session.status !== "running" &&
        !(session.status === "cancelled" && session.hostId) &&
        !(session.status === "timed_out" && session.timedOutHostId))
    ) {
      continue;
    }
    state.providerAccountLeases.set(lease.concurrencyId, {
      sessionId: session.id,
      attemptId: lease.attemptId,
      slot: lease.slot,
      hostId: session.hostId ?? session.timedOutHostId ?? "",
      providerAccountId: lease.providerAccountId,
    });
  }
  for (const worktree of worktrees) state.worktrees.set(worktree.id, worktree);
  for (const record of connections) {
    if (record.registered === false) continue;
    const connection = {
      ...record,
      capabilities: normalizeHostCapabilities(record.capabilities),
      runtime: record.runtime ?? {
        daemonVersion: "legacy/unknown",
        gitVersion: null,
        gitReady: false,
        gitReadinessReason: "git_readiness_unreported" as const,
      },
    };
    state.connections.set(connection.connectionId, connection);
    state.hostConnection.set(connection.hostId, connection.connectionId);
  }
  for (const schedule of schedules) {
    state.schedules.set(schedule.id, {
      ...schedule,
      concurrencyId: schedule.concurrencyId?.trim() || `schedule-${schedule.id}`,
    });
  }
  for (const record of repositories) state.repositories.set(record.id, record);
  for (const record of inventories) {
    state.hostInventories.set(record.hostId, {
      ...record,
      capabilities: normalizeHostCapabilities(record.capabilities),
    });
  }
  for (const record of commands) state.commands.set(record.id, record);
  state.slackIntegration = slackIntegration ?? undefined;
  for (const record of auditLogs) state.auditLogs.set(record.id, record);
  for (const record of usageRecords) {
    state.usageRecords.set(`${record.sessionId}\0${record.attemptId}\0${record.sequence}`, record);
  }
  for (const [sessionId, records] of logs) state.logs.set(sessionId, records);
  for (const record of archives) state.archives.set(record.key, record);
}
