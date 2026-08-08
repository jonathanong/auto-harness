import { randomBytes } from "node:crypto";

import {
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_QUEUE_SHARD_COUNT,
  DEFAULT_USAGE_LIMIT_RETRY_CEILING,
  newId,
  type AgentWireMessage,
} from "@auto-harness/shared";

import type {
  AgentHostRecord,
  CommandRecord,
  DynamoPlaneStorage,
  ProviderAccountRecord,
  ProviderRecord,
  RepositoryRecord,
} from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import type {
  ArchiveObject,
  ConnectionRecord,
  ControlPlaneOptions,
  LogRecord,
  PendingAck,
  PublicSession,
  ScheduleRecord,
  WebhookDelivery,
} from "./control-plane-types.ts";

/** Shared mutable state bag for ControlPlane subsystems. */
export type ControlPlaneState = {
  storage: DynamoPlaneStorage | undefined;
  pendingPersists: Promise<void>[];
  sessions: Map<string, SessionRecord>;
  worktrees: Map<string, WorktreeRecord>;
  connections: Map<string, ConnectionRecord>;
  /** agentId → connectionId (at most one live agent connection — Invariant 3). */
  agentConnection: Map<string, string>;
  logs: Map<string, LogRecord[]>;
  schedules: Map<string, ScheduleRecord>;
  repositories: Map<string, RepositoryRecord>;
  agentHosts: Map<string, AgentHostRecord>;
  providers: Map<string, ProviderRecord>;
  providerAccounts: Map<string, ProviderAccountRecord>;
  commands: Map<string, CommandRecord>;
  archives: Map<string, ArchiveObject>;
  webhookDeliveries: WebhookDelivery[];
  pendingAcks: Map<string, PendingAck>;
  /** Agents in drain: no new assigns; worktrees stay offline after release (Phase 5). */
  drainingAgents: Set<string>;
  /**
   * Agents without a live connection that still need heartbeat-style reclaim
   * (e.g. after disconnect while busy). lastHeartbeatAt is when they went offline.
   */
  disconnectedAgents: Map<string, { lastHeartbeatAt: string }>;
  publicBaseUrl: string;
  now: () => string;
  idFactory: () => string;
  connectionIdFactory: () => string;
  scheduleIdFactory: () => string;
  repositoryIdFactory: () => string;
  providerIdFactory: () => string;
  providerAccountIdFactory: () => string;
  commandIdFactory: () => string;
  shardCount: number;
  ackDeadlineMs: number;
  heartbeatStaleMs: number;
  usageLimitRetryCeiling: number;
  archivePrefix: string;
  webhookUrl: string | null;
  onAgentMessage: ((agentId: string, msg: AgentWireMessage) => void) | undefined;
};

export function createControlPlaneState(options: ControlPlaneOptions = {}): ControlPlaneState {
  return {
    storage: options.storage,
    pendingPersists: [],
    sessions: new Map(),
    worktrees: new Map(),
    connections: new Map(),
    agentConnection: new Map(),
    logs: new Map(),
    schedules: new Map(),
    repositories: new Map(),
    agentHosts: new Map(),
    providers: new Map(),
    providerAccounts: new Map(),
    commands: new Map(),
    archives: new Map(),
    webhookDeliveries: [],
    pendingAcks: new Map(),
    drainingAgents: new Set(),
    disconnectedAgents: new Map(),
    publicBaseUrl: options.publicBaseUrl ?? "http://localhost:7421",
    now: options.now ?? (() => new Date().toISOString()),
    idFactory: options.idFactory ?? (() => `sess-${randomBytes(4).toString("hex")}`),
    connectionIdFactory:
      options.connectionIdFactory ?? (() => `conn-${randomBytes(4).toString("hex")}`),
    scheduleIdFactory: options.scheduleIdFactory
      ? options.scheduleIdFactory
      : () => `sched-${randomBytes(4).toString("hex")}`,
    repositoryIdFactory: options.repositoryIdFactory ? options.repositoryIdFactory : newId,
    providerIdFactory: options.providerIdFactory ? options.providerIdFactory : newId,
    providerAccountIdFactory: options.providerAccountIdFactory
      ? options.providerAccountIdFactory
      : newId,
    commandIdFactory: options.commandIdFactory ? options.commandIdFactory : newId,
    shardCount: options.shardCount ? options.shardCount : DEFAULT_QUEUE_SHARD_COUNT,
    ackDeadlineMs: options.ackDeadlineMs ? options.ackDeadlineMs : DEFAULT_ACK_DEADLINE_MS,
    heartbeatStaleMs: options.heartbeatStaleMs
      ? options.heartbeatStaleMs
      : DEFAULT_HEARTBEAT_STALE_MS,
    usageLimitRetryCeiling: options.usageLimitRetryCeiling
      ? options.usageLimitRetryCeiling
      : DEFAULT_USAGE_LIMIT_RETRY_CEILING,
    archivePrefix: options.archivePrefix ? options.archivePrefix : DEFAULT_ARCHIVE_PREFIX,
    webhookUrl: options.webhookUrl ? options.webhookUrl : null,
    onAgentMessage: options.onAgentMessage,
  };
}
export function queueWrite(state: ControlPlaneState, p: Promise<void>): void {
  state.pendingPersists.push(p);
}

export function persistSession(state: ControlPlaneState, session: SessionRecord): void {
  state.sessions.set(session.id, { ...session });
  if (state.storage) {
    queueWrite(state, state.storage.putSession({ ...session }));
  }
}

export function persistWorktree(state: ControlPlaneState, wt: WorktreeRecord): void {
  state.worktrees.set(wt.id, { ...wt });
  if (state.storage) {
    queueWrite(state, state.storage.putWorktree({ ...wt }));
  }
}

export function toPublic(state: ControlPlaneState, session: SessionRecord): PublicSession {
  return {
    ...session,
    url: `${state.publicBaseUrl}/sessions/${session.id}`,
  };
}

export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export async function hydrateFromStorage(state: ControlPlaneState): Promise<void> {
  if (!state.storage) {
    return;
  }
  state.sessions.clear();
  state.worktrees.clear();
  state.connections.clear();
  state.agentConnection.clear();
  state.logs.clear();
  state.schedules.clear();
  state.repositories.clear();
  state.agentHosts.clear();
  state.providers.clear();
  state.providerAccounts.clear();
  state.commands.clear();
  state.archives.clear();
  for (const s of await state.storage.listAllSessions()) {
    state.sessions.set(s.id, s);
  }
  for (const w of await state.storage.listAllWorktrees()) {
    state.worktrees.set(w.id, w);
  }
  for (const c of await state.storage.listConnections()) {
    state.connections.set(c.connectionId, c);
    state.agentConnection.set(c.agentId, c.connectionId);
  }
  for (const sch of await state.storage.listSchedules()) {
    state.schedules.set(sch.id, sch);
  }
  for (const r of await state.storage.listRepositories()) {
    state.repositories.set(r.id, r);
  }
  for (const h of await state.storage.listAgentHosts()) {
    state.agentHosts.set(h.agentId, h);
  }
  for (const p of await state.storage.listProviders()) {
    state.providers.set(p.id, p);
  }
  for (const pa of await state.storage.listProviderAccounts()) {
    state.providerAccounts.set(pa.id, pa);
  }
  for (const c of await state.storage.listCommands()) {
    state.commands.set(c.id, c);
  }
  for (const a of await state.storage.listArchives()) {
    state.archives.set(a.key, a);
  }
}
export async function settleStorage(state: ControlPlaneState): Promise<void> {
  const pending = state.pendingPersists;
  state.pendingPersists = [];
  await Promise.all(pending);
}
