import { randomBytes } from "node:crypto";

import {
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_QUEUE_SHARD_COUNT,
  DEFAULT_USAGE_LIMIT_RETRY_CEILING,
  formatLogSortKey,
  validateCreateSessionInput,
  type AgentToServerMessage,
  type AgentWireMessage,
  type SessionStatus,
} from "@auto-harness/shared";

import type { DynamoPlaneStorage, RepositoryRecord } from "./db/plane-storage.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { compareSessionsForQueue, compareWorktreesForRoundRobin } from "./services/scheduler.ts";

export type ConnectionRecord = {
  connectionId: string;
  type: "agent" | "client";
  agentId: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  commandProfiles: string[];
};

export type ScheduleRecord = {
  id: string;
  repositoryId: string;
  name: string;
  commandProfile: string;
  cron: string;
  enabled: boolean;
  timeout: number;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  ref?: string;
};

export type LogRecord = {
  sessionId: string;
  timestampSeq: string;
  stream: string;
  content: string;
  timestamp: string;
  seq: number;
};

export type ArchiveObject = {
  key: string;
  body: string;
  contentType: string;
};

export type WebhookDelivery = {
  url: string;
  sessionId: string;
  status: SessionStatus;
  deliveredAt: string;
  payload: string;
};

export type ControlPlaneOptions = {
  /**
   * DynamoDB persistence (Local or AWS). Required for production/local server.
   * When set, durable state is written through and critical claims use conditional
   * DynamoDB updates (Invariants 1, 3, 4).
   */
  storage?: DynamoPlaneStorage;
  publicBaseUrl?: string;
  now?: () => string;
  idFactory?: () => string;
  connectionIdFactory?: () => string;
  scheduleIdFactory?: () => string;
  repositoryIdFactory?: () => string;
  shardCount?: number;
  ackDeadlineMs?: number;
  heartbeatStaleMs?: number;
  usageLimitRetryCeiling?: number;
  archivePrefix?: string;
  /** Opt-in outbound webhook URL (Phase 5). */
  webhookUrl?: string | null;
  onAgentMessage?: (agentId: string, msg: AgentWireMessage) => void;
};

export type PublicSession = SessionRecord & { url: string };

/**
 * Control plane for Phases 2–5 (invariants 1–9).
 * Prefer {@link createControlPlane} so state is backed by DynamoDB Local / AWS.
 * Working-set Maps are a process cache; durable truth is DynamoDB when `storage` is set.
 */
export class ControlPlane {
  private readonly storage: DynamoPlaneStorage | undefined;
  private pendingPersists: Promise<void>[] = [];
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly worktrees = new Map<string, WorktreeRecord>();
  private readonly connections = new Map<string, ConnectionRecord>();
  /** agentId → connectionId (at most one live agent connection — Invariant 3). */
  private readonly agentConnection = new Map<string, string>();
  private readonly logs = new Map<string, LogRecord[]>();
  private readonly schedules = new Map<string, ScheduleRecord>();
  private readonly repositories = new Map<string, RepositoryRecord>();
  private readonly archives = new Map<string, ArchiveObject>();
  private readonly webhookDeliveries: WebhookDelivery[] = [];
  private readonly pendingAcks = new Map<
    string,
    { sessionId: string; worktreeId: string; assignedAtMs: number }
  >();
  /** Agents in drain: no new assigns; worktrees stay offline after release (Phase 5). */
  private readonly drainingAgents = new Set<string>();
  /**
   * Agents without a live connection that still need heartbeat-style reclaim
   * (e.g. after disconnect while busy). lastHeartbeatAt is when they went offline.
   */
  private readonly disconnectedAgents = new Map<string, { lastHeartbeatAt: string }>();

  private readonly publicBaseUrl: string;
  private readonly now: () => string;
  private readonly idFactory: () => string;
  private readonly connectionIdFactory: () => string;
  private readonly scheduleIdFactory: () => string;
  private readonly repositoryIdFactory: () => string;
  private readonly shardCount: number;
  private readonly ackDeadlineMs: number;
  private readonly heartbeatStaleMs: number;
  private readonly usageLimitRetryCeiling: number;
  private readonly archivePrefix: string;
  private webhookUrl: string | null;
  private onAgentMessage: ((agentId: string, msg: AgentWireMessage) => void) | undefined;

  constructor(options: ControlPlaneOptions = {}) {
    this.storage = options.storage;
    this.publicBaseUrl = options.publicBaseUrl ?? "http://localhost:3000";
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => `sess-${randomBytes(4).toString("hex")}`);
    this.connectionIdFactory =
      options.connectionIdFactory ?? (() => `conn-${randomBytes(4).toString("hex")}`);
    this.scheduleIdFactory = options.scheduleIdFactory
      ? options.scheduleIdFactory
      : () => `sched-${randomBytes(4).toString("hex")}`;
    this.repositoryIdFactory = options.repositoryIdFactory
      ? options.repositoryIdFactory
      : () => `repo-${randomBytes(4).toString("hex")}`;
    this.shardCount = options.shardCount ? options.shardCount : DEFAULT_QUEUE_SHARD_COUNT;
    this.ackDeadlineMs = options.ackDeadlineMs ? options.ackDeadlineMs : DEFAULT_ACK_DEADLINE_MS;
    this.heartbeatStaleMs = options.heartbeatStaleMs
      ? options.heartbeatStaleMs
      : DEFAULT_HEARTBEAT_STALE_MS;
    this.usageLimitRetryCeiling = options.usageLimitRetryCeiling
      ? options.usageLimitRetryCeiling
      : DEFAULT_USAGE_LIMIT_RETRY_CEILING;
    this.archivePrefix = options.archivePrefix ? options.archivePrefix : DEFAULT_ARCHIVE_PREFIX;
    this.webhookUrl = options.webhookUrl ? options.webhookUrl : null;
    this.onAgentMessage = options.onAgentMessage;
  }

  /** Wire server→agent delivery (e.g. local WebSocket hub). */
  setOnAgentMessage(handler: ((agentId: string, msg: AgentWireMessage) => void) | undefined): void {
    this.onAgentMessage = handler;
  }

  /** Load durable rows from DynamoDB into the process cache (after ensure tables). */
  async hydrateFromStorage(): Promise<void> {
    if (!this.storage) {
      return;
    }
    this.sessions.clear();
    this.worktrees.clear();
    this.connections.clear();
    this.agentConnection.clear();
    this.logs.clear();
    this.schedules.clear();
    this.repositories.clear();
    this.archives.clear();
    for (const s of await this.storage.listAllSessions()) {
      this.sessions.set(s.id, s);
    }
    for (const w of await this.storage.listAllWorktrees()) {
      this.worktrees.set(w.id, w);
    }
    for (const c of await this.storage.listConnections()) {
      this.connections.set(c.connectionId, c);
      this.agentConnection.set(c.agentId, c.connectionId);
    }
    for (const sch of await this.storage.listSchedules()) {
      this.schedules.set(sch.id, sch);
    }
    for (const r of await this.storage.listRepositories()) {
      this.repositories.set(r.id, r);
    }
    for (const a of await this.storage.listArchives()) {
      this.archives.set(a.key, a);
    }
  }

  private queueWrite(p: Promise<void>): void {
    this.pendingPersists.push(p);
  }

  private persistSession(session: SessionRecord): void {
    this.sessions.set(session.id, { ...session });
    if (this.storage) {
      this.queueWrite(this.storage.putSession({ ...session }));
    }
  }

  private persistWorktree(wt: WorktreeRecord): void {
    this.worktrees.set(wt.id, { ...wt });
    if (this.storage) {
      this.queueWrite(this.storage.putWorktree({ ...wt }));
    }
  }

  /** Wait for DynamoDB write-through to finish (tests / clean shutdown). */
  async settleStorage(): Promise<void> {
    const pending = this.pendingPersists;
    this.pendingPersists = [];
    await Promise.all(pending);
  }

  setWebhookUrl(url: string | null): void {
    this.webhookUrl = url;
  }

  seedWorktree(record: WorktreeRecord): void {
    this.persistWorktree({ ...record });
  }

  listWorktrees(): WorktreeRecord[] {
    return [...this.worktrees.values()].map((w) => ({ ...w }));
  }

  getWorktree(id: string): WorktreeRecord | null {
    const w = this.worktrees.get(id);
    return w ? { ...w } : null;
  }

  listAgents(): Array<{
    agentId: string;
    online: boolean;
    lastHeartbeatAt: string | null;
    commandProfiles: string[];
    worktreeIds: string[];
  }> {
    const byAgent = new Map<
      string,
      {
        agentId: string;
        online: boolean;
        lastHeartbeatAt: string | null;
        commandProfiles: string[];
        worktreeIds: string[];
      }
    >();
    for (const wt of this.worktrees.values()) {
      const cur = byAgent.get(wt.agentId) ?? {
        agentId: wt.agentId,
        online: false,
        lastHeartbeatAt: null,
        commandProfiles: [] as string[],
        worktreeIds: [] as string[],
      };
      cur.worktreeIds.push(wt.id);
      byAgent.set(wt.agentId, cur);
    }
    for (const conn of this.connections.values()) {
      const cur = byAgent.get(conn.agentId) ?? {
        agentId: conn.agentId,
        online: true,
        lastHeartbeatAt: conn.lastHeartbeatAt,
        commandProfiles: conn.commandProfiles,
        worktreeIds: [] as string[],
      };
      cur.online = true;
      cur.lastHeartbeatAt = conn.lastHeartbeatAt;
      cur.commandProfiles = [...conn.commandProfiles];
      byAgent.set(conn.agentId, cur);
    }
    return [...byAgent.values()];
  }

  /** Agent-reported profiles across online agents (for UI dropdown). */
  listCommandProfiles(): string[] {
    const set = new Set<string>();
    for (const a of this.listAgents()) {
      if (a.online) {
        for (const p of a.commandProfiles) {
          set.add(p);
        }
      }
    }
    return [...set].toSorted();
  }

  private toPublic(session: SessionRecord): PublicSession {
    return {
      ...session,
      url: `${this.publicBaseUrl}/sessions/${session.id}`,
    };
  }

  createSession(
    body: unknown,
  ): { ok: true; session: PublicSession } | { ok: false; error: string; code?: string } {
    if (typeof body !== "object" || body === null) {
      return { ok: false, error: "body must be an object" };
    }
    const record = body as Record<string, unknown>;
    const validated = validateCreateSessionInput({
      repositoryId: record.repositoryId,
      prompt: record.prompt,
      commandProfile: record.commandProfile,
      timeout: record.timeout,
      priority: record.priority,
      requiredLabels: record.requiredLabels,
      onConflict: record.onConflict,
      ref: record.ref,
      concurrencyKey: record.concurrencyKey,
      metadata: record.metadata,
    });
    if (!validated.ok) {
      return validated;
    }

    const v = validated.value;
    // Invariant 9: concurrencyKey resolved at create time for queue|replace|reject.
    if (v.concurrencyKey) {
      const active = [...this.sessions.values()].filter(
        (s) =>
          s.concurrencyKey === v.concurrencyKey &&
          (s.status === "queued" || s.status === "running"),
      );
      if (active.length > 0) {
        if (v.onConflict === "reject") {
          return {
            ok: false,
            error: `concurrencyKey ${v.concurrencyKey} is already active on session ${active[0]!.id}`,
            code: "CONFLICT",
          };
        }
        if (v.onConflict === "replace") {
          for (const prev of active) {
            this.supersedeSession(prev.id, "replaced by newer session with same concurrencyKey");
          }
        }
        // onConflict === "queue": leave active sessions; new one also queues.
      }
    }

    const id = this.idFactory();
    const createdAt = this.now();
    const queueShard = Math.abs(hashString(id)) % this.shardCount;
    const session: SessionRecord = {
      id,
      repositoryId: v.repositoryId,
      prompt: v.prompt,
      commandProfile: v.commandProfile,
      timeout: v.timeout,
      priority: v.priority,
      requiredLabels: v.requiredLabels,
      onConflict: v.onConflict,
      status: "queued",
      queueShard,
      createdAt,
      retryCount: 0,
      ...(v.ref !== undefined ? { ref: v.ref } : {}),
      ...(v.concurrencyKey !== undefined ? { concurrencyKey: v.concurrencyKey } : {}),
      ...(v.metadata !== undefined ? { metadata: v.metadata } : {}),
      ...(typeof record.type === "string" ? { type: record.type } : { type: "prompt" }),
      ...(typeof record.source === "string" ? { source: record.source } : { source: "api" }),
    };
    this.persistSession(session);
    return { ok: true, session: this.toPublic(session) };
  }

  getSession(id: string): PublicSession | null {
    const s = this.sessions.get(id);
    return s ? this.toPublic(s) : null;
  }

  /**
   * Local/test helper for the Phase 1 memory facade. Does not apply agent
   * status-validation rules (those are for {@link handleAgentMessage}).
   */
  forceStatus(id: string, status: SessionStatus): PublicSession | null {
    const s = this.sessions.get(id);
    if (!s) {
      return null;
    }
    s.status = status;
    this.persistSession(s);
    return this.toPublic(s);
  }

  listSessions(): PublicSession[] {
    return [...this.sessions.values()]
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((s) => this.toPublic(s));
  }

  /**
   * Conditional agent register (Invariant 3): one live connection per agentId.
   * Second register for same agentId fails unless force-replacing is explicit.
   */
  registerAgent(opts: {
    agentId: string;
    worktrees: Array<{
      id: string;
      repositoryId: string;
      path: string;
      labels: string[];
    }>;
    commandProfiles: string[];
    replaceExisting?: boolean;
  }): { ok: true; connectionId: string } | { ok: false; error: string } {
    const existing = this.agentConnection.get(opts.agentId);
    if (existing && !opts.replaceExisting) {
      return {
        ok: false,
        error: `agentId ${opts.agentId} already has an active connection`,
      };
    }
    if (existing) {
      this.connections.delete(existing);
      this.agentConnection.delete(opts.agentId);
    }

    const connectionId = this.connectionIdFactory();
    const at = this.now();
    if (this.storage) {
      this.queueWrite(
        this.storage
          .tryAcquireAgentLock({
            agentId: opts.agentId,
            connectionId,
            replaceExisting: Boolean(opts.replaceExisting || existing),
          })
          .then(() => {
            /* lock written */
          }),
      );
    }
    const conn: ConnectionRecord = {
      connectionId,
      type: "agent",
      agentId: opts.agentId,
      connectedAt: at,
      lastHeartbeatAt: at,
      commandProfiles: [...opts.commandProfiles],
    };
    this.connections.set(connectionId, conn);
    if (this.storage) {
      this.queueWrite(this.storage.putConnection(conn));
    }
    this.agentConnection.set(opts.agentId, connectionId);
    this.disconnectedAgents.delete(opts.agentId);
    // Re-register clears drain so a restarted agent can take work again.
    this.drainingAgents.delete(opts.agentId);

    for (const wt of opts.worktrees) {
      const prev = this.worktrees.get(wt.id);
      this.persistWorktree({
        id: wt.id,
        agentId: opts.agentId,
        repositoryId: wt.repositoryId,
        path: wt.path,
        labels: wt.labels,
        status: prev && prev.status === "busy" ? "busy" : "idle",
        online: true,
        currentSessionId: prev && prev.currentSessionId != null ? prev.currentSessionId : null,
        lastAssignedAt: prev && prev.lastAssignedAt != null ? prev.lastAssignedAt : null,
      });
    }
    for (const wt of this.worktrees.values()) {
      if (wt.agentId === opts.agentId && !opts.worktrees.some((w) => w.id === wt.id)) {
        wt.online = true;
        this.persistWorktree({ ...wt });
      }
    }
    return { ok: true, connectionId };
  }

  /**
   * Agent disconnect ($disconnect / crash). Immediately:
   * - marks ALL worktrees offline
   * - requeues running sessions and frees busy worktrees
   * - records disconnectedAgents so assigns cannot bind until re-register
   */
  disconnectAgent(connectionId: string): string[] {
    const conn = this.connections.get(connectionId);
    if (!conn) {
      return [];
    }
    const agentId = conn.agentId;
    this.connections.delete(connectionId);
    if (this.agentConnection.get(agentId) === connectionId) {
      this.agentConnection.delete(agentId);
    }
    this.disconnectedAgents.set(agentId, { lastHeartbeatAt: conn.lastHeartbeatAt });
    return this.offlineAgentAndRequeue(agentId, "agent disconnected; requeued");
  }

  /** Offline every worktree for agentId; requeue any running sessions. */
  private offlineAgentAndRequeue(agentId: string, reason: string): string[] {
    const requeued: string[] = [];
    for (const wt of this.worktrees.values()) {
      if (wt.agentId !== agentId) {
        continue;
      }
      wt.online = false;
      if (wt.status === "busy") {
        const sid = wt.currentSessionId;
        this.releaseWorktree(wt.id);
        wt.online = false;
        if (sid) {
          const session = this.sessions.get(sid);
          if (session?.status === "running") {
            session.status = "queued";
            session.worktreeId = null;
            session.agentId = null;
            session.errorMessage = reason;
            this.pendingAcks.delete(sid);
            requeued.push(sid);
          }
        }
      }
    }
    return requeued;
  }

  heartbeat(agentId: string, at?: string): boolean {
    const connectionId = this.agentConnection.get(agentId);
    if (!connectionId) {
      return false;
    }
    const conn = this.connections.get(connectionId);
    // connectionId always maps to a live connection while agentConnection is consistent
    if (!conn) {
      this.agentConnection.delete(agentId);
      return false;
    }
    conn.lastHeartbeatAt = at ?? this.now();
    return true;
  }

  appendLog(opts: {
    sessionId: string;
    stream: string;
    content: string;
    timestamp: string;
    seq: number;
  }): LogRecord {
    const timestampSeq = formatLogSortKey(opts.timestamp, opts.seq);
    const rec: LogRecord = {
      sessionId: opts.sessionId,
      timestampSeq,
      stream: opts.stream,
      content: opts.content,
      timestamp: opts.timestamp,
      seq: opts.seq,
    };
    const list = this.logs.get(opts.sessionId) ?? [];
    list.push(rec);
    // Stable order by timestampSeq (Invariant 5).
    list.sort((a, b) => a.timestampSeq.localeCompare(b.timestampSeq));
    this.logs.set(opts.sessionId, list);
    if (this.storage) {
      this.queueWrite(this.storage.putLog(rec));
    }
    return rec;
  }

  getLogs(sessionId: string): LogRecord[] {
    return [...(this.logs.get(sessionId) ?? [])];
  }

  /**
   * Assign queued sessions with exclusive worktree claim (Invariant 1).
   * Emits session:assign and tracks ack deadline (Invariant 2).
   */
  assignQueued(): Array<{ session: PublicSession; worktree: WorktreeRecord }> {
    const assigned: Array<{ session: PublicSession; worktree: WorktreeRecord }> = [];
    const nowIso = this.now();
    const nowMs = Date.parse(nowIso);

    for (let shard = 0; shard < this.shardCount; shard++) {
      const queued = [...this.sessions.values()]
        .filter((s) => s.status === "queued" && s.queueShard === shard)
        .filter((s) => {
          if (s.retryAfter && Date.parse(s.retryAfter) > nowMs) {
            return false;
          }
          return true;
        })
        .toSorted(compareSessionsForQueue);

      for (const session of queued) {
        if (session.agentId && session.worktreeId && session.ackReceivedAt) {
          continue;
        }
        // Resume pin: only assign to pinned agent when set (Invariant 7).
        // Skip draining / disconnected agents (online must stay false for zombies).
        let idle = [...this.worktrees.values()].filter(
          (w) =>
            w.repositoryId === session.repositoryId &&
            w.status === "idle" &&
            w.online &&
            !this.drainingAgents.has(w.agentId) &&
            !this.disconnectedAgents.has(w.agentId) &&
            session.requiredLabels.every((l) => w.labels.includes(l)),
        );
        if (session.pinnedAgentId) {
          if (session.pinExpiresAt && Date.parse(session.pinExpiresAt) < nowMs) {
            session.errorCode = "resume_failed";
            session.errorMessage = "pin expired";
            session.status = "failed";
            continue;
          }
          idle = idle.filter((w) => w.agentId === session.pinnedAgentId);
        }
        idle.sort(compareWorktreesForRoundRobin);

        for (const candidate of idle) {
          const won = this.tryClaimWorktree(candidate.id, session.id, nowIso);
          if (!won) {
            continue;
          }
          session.status = "running";
          session.worktreeId = candidate.id;
          session.agentId = candidate.agentId;
          session.startedAt = nowIso;
          delete session.ackReceivedAt;
          this.pendingAcks.set(session.id, {
            sessionId: session.id,
            worktreeId: candidate.id,
            assignedAtMs: nowMs,
          });

          const msg: AgentWireMessage = {
            type: "session:assign",
            sessionId: session.id,
            repositoryId: session.repositoryId,
            prompt: session.prompt,
            commandProfile: session.commandProfile,
            timeout: session.timeout,
            worktreeId: candidate.id,
            assignedAt: nowIso,
            ...(session.ref !== undefined ? { ref: session.ref } : {}),
            ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
            ...(session.resumedFromSessionId
              ? {
                  resume: true,
                  resumedFromSessionId: session.resumedFromSessionId,
                  ...(session.cliResumeRef !== undefined
                    ? { cliResumeRef: session.cliResumeRef }
                    : {}),
                }
              : {}),
          };
          this.onAgentMessage?.(candidate.agentId, msg);
          assigned.push({ session: this.toPublic(session), worktree: { ...candidate } });
          break;
        }
      }
    }
    return assigned;
  }

  private tryClaimWorktree(worktreeId: string, sessionId: string, now: string): boolean {
    const wt = this.worktrees.get(worktreeId);
    if (!wt || wt.status !== "idle" || !wt.online) {
      return false;
    }
    wt.status = "busy";
    wt.currentSessionId = sessionId;
    wt.lastAssignedAt = now;
    // Durable write (DynamoDB Local / AWS). Process-local exclusive claim is the Map above;
    // conditional UpdateItem is available on storage for multi-writer deployments.
    this.persistWorktree({ ...wt });
    if (this.storage) {
      this.queueWrite(
        this.storage.tryClaimWorktree({ worktreeId, sessionId, now }).then(() => {
          /* claim written */
        }),
      );
    }
    return true;
  }

  private releaseWorktree(worktreeId: string): void {
    const wt = this.worktrees.get(worktreeId);
    if (!wt) {
      return;
    }
    wt.status = "idle";
    wt.currentSessionId = null;
    // Drain / disconnect are sticky: released worktrees must not become assignable.
    if (this.drainingAgents.has(wt.agentId) || this.disconnectedAgents.has(wt.agentId)) {
      wt.online = false;
    }
    this.persistWorktree({ ...wt });
  }

  /**
   * Cancel/supersede a queued or running session (onConflict:replace).
   * Queued: free immediately. Running: notify agent cancel and keep worktree
   * busy until a late terminal status frees it (avoids racing a new assign on
   * the same path while the old CLI is still inflight).
   */
  private supersedeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    // Caller only passes ids from the active same-key filter.
    if (!session || (session.status !== "queued" && session.status !== "running")) {
      return;
    }
    this.pendingAcks.delete(sessionId);
    const wasRunning = session.status === "running";
    const agentId = session.agentId;
    const worktreeId = session.worktreeId;

    session.status = "cancelled";
    session.errorMessage = reason;
    session.completedAt = this.now();

    if (wasRunning && agentId) {
      this.onAgentMessage?.(agentId, { type: "session:cancel", sessionId });
      // Hold worktree (still busy, currentSessionId = this session) until late terminal.
      this.persistSession(session);
      return;
    }

    if (worktreeId) {
      this.releaseWorktree(worktreeId);
    }
    session.worktreeId = null;
    session.agentId = null;
    this.persistSession(session);
  }

  /** Invariant 2: requeue sessions that never acked. */
  enforceAckDeadlines(nowMs: number = Date.now()): string[] {
    const requeued: string[] = [];
    for (const [sessionId, pending] of this.pendingAcks) {
      if (nowMs - pending.assignedAtMs < this.ackDeadlineMs) {
        continue;
      }
      const session = this.sessions.get(sessionId);
      if (!session || session.ackReceivedAt) {
        this.pendingAcks.delete(sessionId);
        continue;
      }
      this.releaseWorktree(pending.worktreeId);
      session.status = "queued";
      session.worktreeId = null;
      session.agentId = null;
      delete session.startedAt;
      this.pendingAcks.delete(sessionId);
      requeued.push(sessionId);
    }
    return requeued;
  }

  handleAgentMessage(msg: AgentToServerMessage): { ok: boolean; error?: string } {
    switch (msg.type) {
      case "agent:register": {
        const r = this.registerAgent({
          agentId: msg.agentId,
          worktrees: msg.worktrees,
          commandProfiles: msg.commandProfiles,
        });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      }
      case "session:ack": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          return { ok: false, error: "session not found" };
        }
        // Ignore acks after reclaim/replace/cancel rebind.
        if (session.status !== "running") {
          return { ok: true };
        }
        session.ackReceivedAt = this.now();
        this.pendingAcks.delete(msg.sessionId);
        return { ok: true };
      }
      case "session:status": {
        return this.applySessionStatus(msg);
      }
      case "session:log": {
        this.appendLog({
          sessionId: msg.sessionId,
          stream: msg.stream,
          content: msg.content,
          timestamp: msg.timestamp,
          seq: msg.seq,
        });
        return { ok: true };
      }
      case "agent:keepalive": {
        return this.heartbeat(msg.agentId, msg.at)
          ? { ok: true }
          : { ok: false, error: "agent not connected" };
      }
    }
  }

  private applySessionStatus(msg: {
    sessionId: string;
    status: SessionStatus;
    exitCode?: number | null;
    errorCode?: string;
    errorMessage?: string;
    cliResumeRef?: string;
  }): { ok: boolean; error?: string } {
    const session = this.sessions.get(msg.sessionId);
    if (!session) {
      return { ok: false, error: "session not found" };
    }

    const terminal =
      msg.status === "completed" ||
      msg.status === "failed" ||
      msg.status === "cancelled" ||
      msg.status === "timed_out";

    // Late status after disconnect/reclaim/replace must not flip session status.
    // Still release a held worktree on terminal so replace can re-bind safely.
    if (session.status !== "running") {
      if (terminal && session.worktreeId) {
        const wt = this.worktrees.get(session.worktreeId);
        if (wt?.currentSessionId === session.id) {
          this.releaseWorktree(session.worktreeId);
        }
        session.worktreeId = null;
        session.agentId = null;
      }
      return { ok: true };
    }

    session.status = msg.status;
    if (msg.exitCode !== undefined) {
      session.exitCode = msg.exitCode;
    }
    if (msg.errorCode !== undefined) {
      session.errorCode = msg.errorCode;
    }
    if (msg.errorMessage !== undefined) {
      session.errorMessage = msg.errorMessage;
    }
    if (msg.cliResumeRef !== undefined) {
      session.cliResumeRef = msg.cliResumeRef;
    }

    if (terminal) {
      session.completedAt = this.now();
      this.pendingAcks.delete(msg.sessionId);
      if (session.worktreeId) {
        this.releaseWorktree(session.worktreeId);
      }

      // Invariant 6 / D8: usage_limit only.
      let retries = 0;
      if (session.retryCount !== undefined) {
        retries = session.retryCount;
      }
      if (
        msg.status === "failed" &&
        msg.errorCode === "usage_limit" &&
        retries < this.usageLimitRetryCeiling
      ) {
        const retryCount = retries + 1;
        session.retryCount = retryCount;
        const backoffMs = 1000 * 2 ** (retryCount - 1);
        session.retryAfter = new Date(Date.parse(this.now()) + backoffMs).toISOString();
        session.status = "queued";
        session.worktreeId = null;
        session.agentId = null;
        delete session.completedAt;
      } else {
        session.worktreeId = null;
        void this.archiveSessionLogs(session.id);
        void this.maybeDeliverWebhook(session);
      }
    }
    this.persistSession(session);
    return { ok: true };
  }

  /**
   * Resume: pin agent only (D5), re-checkout via ref later on agent.
   */
  resumeSession(
    sessionId: string,
    opts: { pinExpiresAt?: string } = {},
  ): { ok: true; session: PublicSession } | { ok: false; error: string } {
    const source = this.sessions.get(sessionId);
    if (!source) {
      return { ok: false, error: "session not found" };
    }
    const pin = source.agentId || source.pinnedAgentId;
    if (!pin) {
      return { ok: false, error: "source session has no agent to pin" };
    }
    const id = this.idFactory();
    const createdAt = this.now();
    const pinExpiresAt =
      opts.pinExpiresAt === undefined
        ? new Date(Date.parse(createdAt) + 3600_000).toISOString()
        : opts.pinExpiresAt;
    const resumed: SessionRecord = {
      id,
      repositoryId: source.repositoryId,
      prompt: source.prompt,
      commandProfile: source.commandProfile,
      timeout: source.timeout,
      priority: source.priority,
      requiredLabels: [...source.requiredLabels],
      onConflict: source.onConflict,
      status: "queued",
      queueShard: Math.abs(hashString(id)) % this.shardCount,
      createdAt,
      retryCount: 0,
      resumedFromSessionId: sessionId,
      pinnedAgentId: pin,
      pinExpiresAt,
      ...(source.ref !== undefined ? { ref: source.ref } : {}),
      ...(source.cliResumeRef !== undefined ? { cliResumeRef: source.cliResumeRef } : {}),
      ...(source.concurrencyKey !== undefined ? { concurrencyKey: source.concurrencyKey } : {}),
      ...(source.metadata !== undefined ? { metadata: source.metadata } : {}),
      type: "prompt",
      source: "api",
    };
    this.persistSession(resumed);
    return { ok: true, session: this.toPublic(resumed) };
  }

  putSchedule(input: {
    repositoryId: string;
    name: string;
    commandProfile: string;
    cron: string;
    timeout: number;
    nextRunAt: string;
    enabled?: boolean;
    ref?: string;
    id?: string;
  }): ScheduleRecord {
    const id = input.id ?? this.scheduleIdFactory();
    const rec: ScheduleRecord = {
      id,
      repositoryId: input.repositoryId,
      name: input.name,
      commandProfile: input.commandProfile,
      cron: input.cron,
      enabled: input.enabled ?? true,
      timeout: input.timeout,
      nextRunAt: input.nextRunAt,
      lastRunAt: null,
      createdAt: this.now(),
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
    };
    this.schedules.set(id, rec);
    if (this.storage) {
      this.queueWrite(this.storage.putSchedule({ ...rec }));
    }
    return { ...rec };
  }

  getSchedule(id: string): ScheduleRecord | null {
    const s = this.schedules.get(id);
    return s ? { ...s } : null;
  }

  listSchedules(): ScheduleRecord[] {
    return [...this.schedules.values()].map((s) => ({ ...s }));
  }

  updateSchedule(
    id: string,
    patch: Partial<{
      name: string;
      commandProfile: string;
      cron: string;
      timeout: number;
      nextRunAt: string;
      enabled: boolean;
      ref: string;
      repositoryId: string;
    }>,
  ): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
    const existing = this.schedules.get(id);
    if (!existing) {
      return { ok: false, error: "schedule not found" };
    }
    const next: ScheduleRecord = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.commandProfile !== undefined ? { commandProfile: patch.commandProfile } : {}),
      ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
      ...(patch.timeout !== undefined ? { timeout: patch.timeout } : {}),
      ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.repositoryId !== undefined ? { repositoryId: patch.repositoryId } : {}),
      ...(patch.ref !== undefined ? { ref: patch.ref } : {}),
    };
    this.schedules.set(id, next);
    if (this.storage) {
      this.queueWrite(this.storage.putSchedule({ ...next }));
    }
    return { ok: true, schedule: { ...next } };
  }

  deleteSchedule(id: string): { ok: true } | { ok: false; error: string } {
    if (!this.schedules.has(id)) {
      return { ok: false, error: "schedule not found" };
    }
    this.schedules.delete(id);
    if (this.storage) {
      this.queueWrite(this.storage.deleteSchedule(id));
    }
    return { ok: true };
  }

  /**
   * Manual trigger: creates one scheduled session and advances nextRunAt
   * (same provenance as cron: type/source schedule).
   */
  triggerSchedule(
    id: string,
    nowIso: string = this.now(),
  ): { ok: true; session: PublicSession } | { ok: false; error: string } {
    const schedule = this.schedules.get(id);
    if (!schedule) {
      return { ok: false, error: "schedule not found" };
    }
    if (!schedule.enabled) {
      return { ok: false, error: "schedule is disabled" };
    }
    schedule.nextRunAt = new Date(Date.parse(nowIso) + 60_000).toISOString();
    schedule.lastRunAt = nowIso;
    if (this.storage) {
      this.queueWrite(this.storage.putSchedule({ ...schedule }));
    }
    const result = this.createSession({
      repositoryId: schedule.repositoryId,
      prompt: `scheduled:${schedule.name}`,
      commandProfile: schedule.commandProfile,
      timeout: schedule.timeout,
      type: "scheduled",
      source: "schedule",
      ...(schedule.ref !== undefined ? { ref: schedule.ref } : {}),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, session: result.session };
  }

  createRepository(input: {
    id?: string;
    name: string;
    url: string;
    defaultBranch?: string;
    setupScript?: string;
    terminalHookScript?: string;
  }): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
    if (!input.name || !input.url) {
      return { ok: false, error: "name and url are required" };
    }
    const id = input.id ?? this.repositoryIdFactory();
    if (this.repositories.has(id)) {
      return { ok: false, error: `repository already exists: ${id}` };
    }
    const at = this.now();
    const rec: RepositoryRecord = {
      id,
      name: input.name,
      url: input.url,
      defaultBranch: input.defaultBranch ?? "main",
      createdAt: at,
      updatedAt: at,
      ...(input.setupScript !== undefined ? { setupScript: input.setupScript } : {}),
      ...(input.terminalHookScript !== undefined
        ? { terminalHookScript: input.terminalHookScript }
        : {}),
    };
    this.repositories.set(id, rec);
    if (this.storage) {
      this.queueWrite(this.storage.putRepository({ ...rec }));
    }
    return { ok: true, repository: { ...rec } };
  }

  getRepository(id: string): RepositoryRecord | null {
    const r = this.repositories.get(id);
    return r ? { ...r } : null;
  }

  listRepositories(): RepositoryRecord[] {
    return [...this.repositories.values()]
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((r) => ({ ...r }));
  }

  updateRepository(
    id: string,
    patch: Partial<{
      name: string;
      url: string;
      defaultBranch: string;
      setupScript: string;
      terminalHookScript: string;
    }>,
  ): { ok: true; repository: RepositoryRecord } | { ok: false; error: string } {
    const existing = this.repositories.get(id);
    if (!existing) {
      return { ok: false, error: "repository not found" };
    }
    const next: RepositoryRecord = {
      ...existing,
      updatedAt: this.now(),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.defaultBranch !== undefined ? { defaultBranch: patch.defaultBranch } : {}),
      ...(patch.setupScript !== undefined ? { setupScript: patch.setupScript } : {}),
      ...(patch.terminalHookScript !== undefined
        ? { terminalHookScript: patch.terminalHookScript }
        : {}),
    };
    this.repositories.set(id, next);
    if (this.storage) {
      this.queueWrite(this.storage.putRepository({ ...next }));
    }
    return { ok: true, repository: { ...next } };
  }

  deleteRepository(id: string): { ok: true } | { ok: false; error: string } {
    if (!this.repositories.has(id)) {
      return { ok: false, error: "repository not found" };
    }
    this.repositories.delete(id);
    if (this.storage) {
      this.queueWrite(this.storage.deleteRepository(id));
    }
    return { ok: true };
  }

  /**
   * Cancel a non-terminal session. Running sessions emit session:cancel and
   * keep the worktree busy until a late terminal (same as replace).
   */
  cancelSession(id: string): { ok: true; session: PublicSession } | { ok: false; error: string } {
    const session = this.sessions.get(id);
    if (!session) {
      return { ok: false, error: "session not found" };
    }
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "cancelled" ||
      session.status === "timed_out"
    ) {
      return { ok: false, error: `session already terminal: ${session.status}` };
    }
    this.pendingAcks.delete(id);
    const wasRunning = session.status === "running";
    const agentId = session.agentId;
    const worktreeId = session.worktreeId;
    session.status = "cancelled";
    session.errorMessage = "cancelled by operator";
    session.completedAt = this.now();
    if (wasRunning && agentId) {
      this.onAgentMessage?.(agentId, { type: "session:cancel", sessionId: id });
      this.persistSession(session);
      return { ok: true, session: this.toPublic(session) };
    }
    if (worktreeId) {
      this.releaseWorktree(worktreeId);
    }
    session.worktreeId = null;
    session.agentId = null;
    this.persistSession(session);
    return { ok: true, session: this.toPublic(session) };
  }

  /**
   * Cron evaluation with conditional nextRunAt claim (Invariant 4).
   * Concurrent callers: only one advances nextRunAt and creates a session.
   */
  evaluateCron(nowIso: string = this.now()): PublicSession[] {
    const created: PublicSession[] = [];
    const nowMs = Date.parse(nowIso);
    for (const schedule of this.schedules.values()) {
      if (!schedule.enabled) {
        continue;
      }
      if (Date.parse(schedule.nextRunAt) > nowMs) {
        continue;
      }
      // Conditional claim via tryClaimScheduleFire (Invariant 4).
      const fired = this.tryClaimScheduleFire(schedule.id, schedule.nextRunAt, nowIso);
      if (fired) {
        created.push(fired);
      }
    }
    return created;
  }

  /**
   * Concurrent-safe claim used by tests: only the first caller with matching expectedNextRunAt wins.
   */
  tryClaimScheduleFire(
    scheduleId: string,
    expectedNextRunAt: string,
    nowIso: string,
  ): PublicSession | null {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || !schedule.enabled) {
      return null;
    }
    if (schedule.nextRunAt !== expectedNextRunAt) {
      return null;
    }
    if (Date.parse(expectedNextRunAt) > Date.parse(nowIso)) {
      return null;
    }
    schedule.nextRunAt = new Date(Date.parse(nowIso) + 60_000).toISOString();
    schedule.lastRunAt = nowIso;
    const result = this.createSession({
      repositoryId: schedule.repositoryId,
      prompt: `scheduled:${schedule.name}`,
      commandProfile: schedule.commandProfile,
      timeout: schedule.timeout,
      type: "scheduled",
      source: "schedule",
      ...(schedule.ref !== undefined ? { ref: schedule.ref } : {}),
    });
    if (!result.ok) {
      return null;
    }
    return result.session;
  }

  /**
   * Heartbeat-based stale reclaim (Phase 3): free worktrees of agents whose
   * heartbeat is older than heartbeatStaleMs — faster than full session timeout.
   * Also reclaims agents recorded in disconnectedAgents after disconnect/crash.
   * Marks ALL of the agent's worktrees offline (idle + busy) so assigns cannot
   * bind to a zombie agent.
   */
  reclaimStaleAgents(nowMs: number = Date.now()): string[] {
    const reclaimed: string[] = [];
    const candidates = new Map<string, { lastHeartbeatAt: string; connectionId?: string }>();

    for (const [agentId, connectionId] of this.agentConnection.entries()) {
      const conn = this.connections.get(connectionId);
      if (!conn) {
        this.agentConnection.delete(agentId);
        continue;
      }
      candidates.set(agentId, {
        lastHeartbeatAt: conn.lastHeartbeatAt,
        connectionId,
      });
    }
    for (const [agentId, rec] of this.disconnectedAgents.entries()) {
      if (!candidates.has(agentId)) {
        candidates.set(agentId, { lastHeartbeatAt: rec.lastHeartbeatAt });
      }
    }

    for (const [agentId, meta] of candidates) {
      const last = Date.parse(meta.lastHeartbeatAt);
      if (nowMs - last < this.heartbeatStaleMs) {
        continue;
      }
      const freed = this.offlineAgentAndRequeue(agentId, "agent heartbeat stale; requeued");
      for (const sid of freed) {
        if (!reclaimed.includes(sid)) {
          reclaimed.push(sid);
        }
      }
      if (meta.connectionId) {
        this.connections.delete(meta.connectionId);
      }
      this.agentConnection.delete(agentId);
      this.disconnectedAgents.delete(agentId);
    }
    return reclaimed;
  }

  getHeartbeatStaleMs(): number {
    return this.heartbeatStaleMs;
  }

  getAckDeadlineMs(): number {
    return this.ackDeadlineMs;
  }

  getUsageLimitRetryCeiling(): number {
    return this.usageLimitRetryCeiling;
  }

  archiveSessionLogs(sessionId: string): ArchiveObject | null {
    const logs = this.getLogs(sessionId);
    if (logs.length === 0) {
      const empty: ArchiveObject = {
        key: `${this.archivePrefix}${sessionId}.json`,
        body: "[]",
        contentType: "application/json",
      };
      this.archives.set(empty.key, empty);
      if (this.storage) {
        this.queueWrite(this.storage.putArchive(empty));
      }
      return empty;
    }
    const body = JSON.stringify(logs);
    const obj: ArchiveObject = {
      key: `${this.archivePrefix}${sessionId}.json`,
      body,
      contentType: "application/json",
    };
    this.archives.set(obj.key, obj);
    if (this.storage) {
      this.queueWrite(this.storage.putArchive(obj));
    }
    return obj;
  }

  getArchive(sessionId: string): ArchiveObject | null {
    const key = `${this.archivePrefix}${sessionId}.json`;
    if (!this.archives.has(key)) {
      return null;
    }
    return this.archives.get(key)!;
  }

  listArchives(): ArchiveObject[] {
    return [...this.archives.values()];
  }

  private maybeDeliverWebhook(session: SessionRecord): void {
    if (!this.webhookUrl) {
      return;
    }
    const payload = JSON.stringify({
      sessionId: session.id,
      status: session.status,
      errorCode: session.errorCode ?? null,
      url: `${this.publicBaseUrl}/sessions/${session.id}`,
    });
    this.webhookDeliveries.push({
      url: this.webhookUrl,
      sessionId: session.id,
      status: session.status,
      deliveredAt: this.now(),
      payload,
    });
  }

  listWebhookDeliveries(): WebhookDelivery[] {
    return [...this.webhookDeliveries];
  }

  /**
   * Phase 5: mark agent draining — no new assigns until re-register.
   * Sticky: released busy worktrees stay offline via releaseWorktree.
   */
  drainAgent(agentId: string): { ok: boolean; runningSessionIds: string[] } {
    this.drainingAgents.add(agentId);
    const running = [...this.sessions.values()]
      .filter((s) => s.agentId === agentId && s.status === "running")
      .map((s) => s.id);
    this.onAgentMessage?.(agentId, { type: "agent:drain" });
    for (const wt of this.worktrees.values()) {
      if (wt.agentId === agentId) {
        // Idle: offline now. Busy: stay busy until release, then releaseWorktree keeps offline.
        if (wt.status === "idle") {
          wt.online = false;
        }
      }
    }
    return { ok: true, runningSessionIds: running };
  }

  isDraining(agentId: string): boolean {
    return this.drainingAgents.has(agentId);
  }
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
