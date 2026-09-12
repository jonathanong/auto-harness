/* eslint-disable max-lines -- ordered daemon lifecycle belongs in this single loop. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION,
  DEFERRED_TERMINAL_RESULT_PROTOCOL_VERSION,
  KEEPALIVE_ACK_PROTOCOL_VERSION,
  SESSION_RESULT_PROTOCOL_VERSION,
  TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION,
  thrownMessage,
  type HostRuntimeReport,
  type HostToServerMessage,
  type HostWireMessage,
  type SessionAssign,
  type SessionLogChunk,
} from "@auto-harness/shared";
import type { DaemonTransport } from "./daemon-transport-types.ts";
import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { PtyProcessRunner } from "./pty-runner.ts";
import { UsageCapturingProcessRunner } from "./usage-adapter.ts";
import { createGitClient } from "./git.ts";
import { configureConnectionEvents } from "./daemon-connection-events.ts";
import {
  applyDaemonInventory,
  registerDaemon,
  type DaemonRuntimeIdentity,
} from "./daemon-registration.ts";
import { sendDaemonLog } from "./daemon-log-sender.ts";
import { OutboundQueue } from "./outbound-queue.ts";
import {
  emptyExecutionProfiles,
  executionProfileReady,
  providerAccountReadiness,
  resolveExecutionProfile,
  type ExecutionProfiles,
} from "./execution-profiles.ts";
import { resolvedRouteMetadata, sessionAssignFromWire } from "./session-assign.ts";
import type { SessionRunResult } from "./session-runner.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager, type ClaimedWorktree } from "./worktree-manager.ts";
import { WorkspaceManager } from "./workspace-manager.ts";
import { probeGitReadiness } from "./git-readiness.ts";
import { withTimeout } from "./with-timeout.ts";
import { runTerminalHook } from "./terminal-hook.ts";
import { collectSessionResult } from "./session-result.ts";
import {
  GITHUB_APP_TOKEN_MARGIN_MS,
  loadGitHubAppConfig,
  mintInstallationToken,
  withoutAmbientGitHubTokens,
  withInstallationToken,
  withIsolatedGitHubConfigDir,
  type GitHubAppConfig,
} from "./github-app.ts";
import { SecretRedactingProcessRunner } from "./secret-redacting-runner.ts";
export type { DaemonTransport } from "./daemon-transport-types.ts";
export type DaemonLoopOptions = {
  config: DaemonConfig;
  transport: DaemonTransport;
  processRunner?: ProcessRunner;
  commandRunner?: ProcessRunner;
  /** Daemon environment after loading the persisted service environment file. */
  childEnvSource?: NodeJS.ProcessEnv;
  /** Daemon-local execution profiles keyed by provider account. */
  executionProfiles?: ExecutionProfiles;
  githubApp?: GitHubAppConfig;
  isDraining?: () => boolean;
  onLog?: (line: string) => void;
  now?: () => string;
  reconnectAbortMs?: number;
  /** Maximum wait for peer confirmation that `session:ack` committed. */
  ackConfirmationMs?: number;
  /** Retry an unacknowledged durable drain notification at this interval. */
  drainRetryMs?: number;
  /**
   * Upper bound on waiting for the control plane to acknowledge a drain. Reaching it
   * proceeds to the in-flight wait rather than retrying forever.
   */
  drainDeadlineMs?: number;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  /** Stable process identity; injectable only to make restart semantics deterministic in tests. */
  daemonIdentity?: DaemonRuntimeIdentity;
  /** Startup preflight from the CLI; direct loop users probe during start(). */
  runtime?: HostRuntimeReport;
  /** Stop retrying an unacknowledged terminal `session:status` after this long. */
  pendingStatusMaxAgeMs?: number;
  /** Stop retaining new unacknowledged terminal statuses once this many are pending. */
  pendingStatusMaxCount?: number;
  /** Retry at most this many pending terminal statuses per keepalive tick. */
  statusRetriesPerTick?: number;
  /** Legacy v6 deferred-result completions have no absolute handoff expiry. */
  pendingTerminalHookHandoffMaxAgeMs?: number;
  /** Bound replacement-hook completion retention while the server is unreachable. */
  pendingTerminalHookHandoffMaxCount?: number;
  /**
   * Bound on one keepalive attempt. A stalled outbound write (the transport
   * thinks it's connected but nothing is actually being delivered) otherwise
   * leaves `outbound.send()`'s promise pending forever, so it never rejects
   * and "keepalive failed" never logs even during a real outage.
   */
  keepaliveTimeoutMs?: number;
  /**
   * Force the transport to abandon its current connection and reconnect once
   * this long has passed without peer evidence the connection still works.
   * At protocol 2 that evidence is `host:registered` / `host:keepalive-ack`;
   * older peers still re-arm on a successful local send. Comfortably under
   * the control plane's default 60s heartbeat staleness window, so the daemon
   * gives up on a connection that looks open but isn't carrying traffic
   * before the control plane gives up on the daemon.
   */
  keepaliveStallMs?: number;
};
type InflightSession = {
  sessionId: string;
  attemptId: string;
  controller: AbortController;
  work: Promise<void>;
  /** Set only by a server `session:acknowledged` wire message. */
  acknowledged: boolean;
  // Cleared back to undefined once fired, not deleted, so both states need an
  // explicit type under exactOptionalPropertyTypes.
  resolveAcknowledgement?: (() => void) | undefined;
};

/**
 * A sent `session:status` this daemon has not yet seen `session:status-acknowledged`
 * for. A completed WebSocket write is not delivery (see ws-transport.ts): the message
 * is retried on every keepalive until acked, or dropped after `pendingStatusMaxAgeMs`.
 */
type PendingTerminalStatus = {
  message: Extract<HostToServerMessage, { type: "session:status" }>;
  firstAttemptedAtMs: number;
  /** True while a resend for this entry is queued or in flight. Guards
   * against re-enqueuing a duplicate retained frame every keepalive tick
   * while the prior attempt is still sitting undelivered (e.g. a socket
   * that is down but has not yet rejected the queued write). */
  sending: boolean;
  /**
   * Shared across every send attempt for this entry so giving up on it can
   * actually cancel a still-buffered write. Without this, a frame retained
   * by `WsOutboundBuffer` during a prolonged outage stays queued and is
   * eventually transmitted even after `pendingStatusMaxAgeMs` logged it as
   * abandoned.
   */
  controller: AbortController;
  /** Set only for a v6 checkout failure awaiting durable retry/hook settlement. */
  settleDeferredTerminalHook?:
    | ((
        runHook: boolean,
        deadlineAtMs?: number,
      ) => Promise<import("@auto-harness/shared").SessionResult | undefined>)
    | undefined;
  /** An acknowledged deferred status remains discoverable until its hook settles. */
  settlement?: Promise<void> | undefined;
  /** The shared hook result for a same-process handoff that overlaps its status ACK. */
  settlementResult?: Promise<import("@auto-harness/shared").SessionResult | undefined> | undefined;
  resolveDeferredDisposition?: (() => void) | undefined;
};

type PendingCommandStart = {
  message: Extract<HostToServerMessage, { type: "session:command-start" }>;
  signal: AbortSignal;
  resolve: (authorized: boolean) => void;
  onAbort: () => void;
  sending: boolean;
};

/** A v6 status acknowledgement can synthesize a local completion before its v7 handoff arrives. */
type PendingTerminalHookHandoffMessage = Omit<
  Extract<HostWireMessage, { type: "session:terminal-hook" }>,
  "expiresAt"
> & { expiresAt?: string };

type PendingTerminalHookHandoff = {
  message: PendingTerminalHookHandoffMessage;
  expiresAtMs?: number;
  /** Retained solely for legacy v6 deferred-result completions. */
  firstAttemptedAtMs?: number;
  complete: boolean;
  executing: boolean;
  sending: boolean;
  /** Active recovery work; shutdown must retain the transport until it settles. */
  work?: Promise<void> | undefined;
  /** A completion write in progress; successful local delivery is the shutdown fence. */
  completionSend?: Promise<void> | undefined;
  /** Cancels a completion buffered behind a disconnected transport during shutdown. */
  completionController?: AbortController | undefined;
  result?: import("@auto-harness/shared").SessionResult;
};

const DEFAULT_PENDING_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/**
 * Ceiling on retained terminal statuses, comfortably under the control
 * plane's 1,000-entry `runningSessions` wire limit. Guards a daemon deployed
 * against a not-yet-upgraded control plane (which never sends
 * `session:status-acknowledged`) from growing this set without bound until a
 * keepalive/registration is rejected as invalid and the connection drops.
 */
const DEFAULT_PENDING_STATUS_MAX_COUNT = 500;
/**
 * Ceiling on how many retries `retryPendingTerminalStatuses` issues in a
 * single keepalive tick. Retained statuses can build up close to
 * `pendingStatusMaxCount`, and the control plane closes the socket once a
 * connection exceeds 100 messages in a one-second window (`ws-hub.ts`); a
 * large backlog resent in one burst — plus whatever other traffic (logs,
 * acks) shares that same window — could trip that limit. Spreading a large
 * backlog across multiple 20s ticks instead keeps every tick well under it.
 */
const DEFAULT_STATUS_RETRIES_PER_TICK = 20;
const DEFAULT_PENDING_TERMINAL_HOOK_HANDOFF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PENDING_TERMINAL_HOOK_HANDOFF_MAX_COUNT = 500;

function inflightKey(sessionId: string, attemptId: string): string {
  return `${sessionId}\0${attemptId}`;
}

function assignmentTargetKey(msg: Extract<HostWireMessage, { type: "session:assign" }>): string {
  // Workspace sessions have no repository checkout. Their configured pool/slot
  // pair identifies the physical target, so separate slots must not inherit
  // the `main\0null` fence while repeated assignments to one slot stay ordered.
  if (msg.workspacePoolId && msg.workspaceSlotId) {
    return `workspace\0${msg.workspacePoolId}\0${msg.workspaceSlotId}`;
  }
  // Worktree ids are currently host inventory identifiers, but repository
  // scope avoids coupling this daemon-side fence to that representation. Main
  // checkout assignments are serialized by their repository lock as well.
  return msg.worktreeId === null
    ? `main\0${msg.repositoryId}`
    : `worktree\0${msg.repositoryId}\0${msg.worktreeId}`;
}

export class DaemonLoop {
  private readonly runner: SessionRunner;
  private readonly worktrees: WorktreeManager;
  private readonly workspaces: WorkspaceManager;
  private readonly inflight = new Map<string, InflightSession>();
  /**
   * Assignment completion fences by physical execution target. A checkout
   * claim may intentionally outlive `SessionRunner.run()` while protocol 4
   * waits for its durable retry disposition, so a different logical session
   * must not start on that same worktree in the meantime.
   */
  private readonly worktreeAssignmentTails = new Map<string, Promise<void>>();
  private readonly pendingTerminalStatus = new Map<string, PendingTerminalStatus>();
  /** Replacement-daemon hook completions retained until the API confirms their fence. */
  private readonly pendingTerminalHookHandoffs = new Map<string, PendingTerminalHookHandoff>();
  /** Recovery hooks share the daemon's bounded execution capacity with CLI sessions. */
  private activeTerminalHookHandoffs = 0;
  private readonly pendingCommandStarts = new Map<string, PendingCommandStart>();
  private readonly pendingStatusMaxAgeMs: number;
  private readonly pendingStatusMaxCount: number;
  private readonly statusRetriesPerTick: number;
  private readonly pendingTerminalHookHandoffMaxAgeMs: number;
  private readonly pendingTerminalHookHandoffMaxCount: number;
  private readonly nextLogSeq = new Map<string, number>();
  private draining = false;
  /** A polled allowed-roots policy rejected this daemon's paths; clear only after a valid apply. */
  private inventoryPolicyBlocked = false;
  /** Tracks whether the control plane has acknowledged the policy drain registration. */
  private inventoryPolicyDrainPublished = false;
  /** Set before a drain write so reconnect registration cannot reopen capacity. */
  private drainRequested = false;
  /** Stop awaiting recoverable delivery while graceful shutdown is in progress. */
  private settleDeferredOnCompletion = false;
  private drainConfirmation: Promise<void> | undefined;
  private resolveDrainConfirmation: (() => void) | undefined;
  private drainRetry: ReturnType<typeof setTimeout> | undefined;
  private readonly isDrainingExternal: (() => boolean) | undefined;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly now: () => string;
  private readonly config: DaemonConfig;
  private readonly transport: DaemonTransport;
  private readonly outbound: OutboundQueue;
  private readonly reconnectAbortMs: number;
  private readonly ackConfirmationMs: number;
  private readonly drainRetryMs: number;
  private readonly drainDeadlineMs: number;
  private drainDeadline: ReturnType<typeof setTimeout> | undefined;
  private readonly keepaliveTimeoutMs: number;
  private readonly keepaliveStallMs: number;
  private keepaliveStallTimer: ReturnType<typeof setTimeout> | undefined;
  /** Control-plane protocol negotiated by the latest accepted registration. */
  private serverProtocolVersion = 0;
  /**
   * Set from `host:registered.protocolVersion`. When true, a local keepalive
   * write is not evidence the peer received it — only `host:keepalive-ack`
   * (and a fresh `host:registered`) re-arm the stall timer.
   */
  private requireKeepaliveAck = false;
  /** A result is only sent after the control plane has explicitly negotiated v3. */
  private supportsSessionResult = false;
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private readonly daemonIdentity: DaemonRuntimeIdentity;
  private readonly processRunner: ProcessRunner;
  private readonly childEnvSource: NodeJS.ProcessEnv;
  private readonly executionProfiles: ExecutionProfiles;
  private readonly githubApp: GitHubAppConfig | undefined;
  private advertisedProviderAccountReadiness = "";
  private runtime: HostRuntimeReport | undefined;
  private connectionEvents: { stop: () => void } | undefined;
  constructor(options: DaemonLoopOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.isDrainingExternal = options.isDraining ?? undefined;
    this.onLog = options.onLog ?? undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    this.daemonIdentity = options.daemonIdentity ?? {
      instanceId: randomUUID(),
      startedAt: this.now(),
    };
    this.reconnectAbortMs = options.reconnectAbortMs ?? 75_000;
    this.ackConfirmationMs = options.ackConfirmationMs ?? this.reconnectAbortMs;
    this.drainRetryMs = options.drainRetryMs ?? 1_000;
    this.drainDeadlineMs = options.drainDeadlineMs ?? 30_000;
    this.pendingStatusMaxAgeMs = options.pendingStatusMaxAgeMs ?? DEFAULT_PENDING_STATUS_MAX_AGE_MS;
    this.pendingStatusMaxCount = options.pendingStatusMaxCount ?? DEFAULT_PENDING_STATUS_MAX_COUNT;
    this.statusRetriesPerTick = options.statusRetriesPerTick ?? DEFAULT_STATUS_RETRIES_PER_TICK;
    this.pendingTerminalHookHandoffMaxAgeMs =
      options.pendingTerminalHookHandoffMaxAgeMs ??
      DEFAULT_PENDING_TERMINAL_HOOK_HANDOFF_MAX_AGE_MS;
    this.pendingTerminalHookHandoffMaxCount =
      options.pendingTerminalHookHandoffMaxCount ?? DEFAULT_PENDING_TERMINAL_HOOK_HANDOFF_MAX_COUNT;
    this.keepaliveTimeoutMs = options.keepaliveTimeoutMs ?? 10_000;
    // Comfortably under the control plane's default 60s heartbeat staleness
    // window (DEFAULT_HEARTBEAT_STALE_MS in modules/shared) — not imported
    // directly, since a deployment can configure a different value and this
    // daemon-side margin only needs to stay well clear of whatever it is.
    this.keepaliveStallMs = options.keepaliveStallMs ?? 45_000;
    this.timers = options.timers ?? globalThis;
    this.outbound = new OutboundQueue(this.transport, (line) => this.onLog?.(line));
    const processRunner = options.processRunner ?? new SpawnProcessRunner();
    this.processRunner = processRunner;
    this.childEnvSource = options.childEnvSource ?? process.env;
    this.runtime = options.runtime;
    this.executionProfiles = options.executionProfiles ?? emptyExecutionProfiles();
    this.githubApp =
      options.githubApp ?? loadGitHubAppConfig(options.childEnvSource ?? process.env);
    const innerCommandRunner =
      options.commandRunner ??
      (options.processRunner ? processRunner : new PtyProcessRunner({ emitUntruncated: true }));
    // Preserve explicitly supplied command runners as test and operator seams;
    // production command execution is wrapped so provider usage envelopes are retained.
    const commandRunner = options.commandRunner
      ? innerCommandRunner
      : new UsageCapturingProcessRunner(innerCommandRunner, this.now);
    const git = createGitClient(processRunner);
    this.worktrees = new WorktreeManager(options.config, git);
    this.workspaces = new WorkspaceManager(options.config);
    this.runner = new SessionRunner({
      worktrees: this.worktrees,
      workspaces: this.workspaces,
      processRunner,
      commandRunner,
      ...(options.childEnvSource ? { childEnvSource: options.childEnvSource } : {}),
      executionProfiles: this.executionProfiles,
      ...(this.githubApp ? { githubApp: this.githubApp } : {}),
      ...(options.config.apiUrl
        ? {
            identity: {
              apiUrl: options.config.apiUrl,
              ...(options.config.apiKey ? { apiKey: options.config.apiKey } : {}),
            },
          }
        : {}),
      onLog: (chunk) => void this.emitLog(chunk),
      now: this.now,
      authorizeCommandStart: (assign, signal) => this.authorizeCommandStart(assign, signal),
    });
  }
  async start(): Promise<void> {
    this.runtime ??= await probeGitReadiness(this.processRunner);
    if (this.runtime.gitReady) await this.worktrees.ensureAll();
    await this.workspaces.ensureAll();
    this.transport.onMessage((msg) => {
      void this.handleServerMessage(msg).catch((err: unknown) => {
        this.onLog?.(`server message failed: ${thrownMessage(err)}`);
      });
    });
    this.connectionEvents = configureConnectionEvents({
      transport: this.transport,
      register: () => this.register(),
      onError: (error) => this.onLog?.(`re-register failed: ${String(error)}`),
      abortUnacknowledged: () => {
        for (const session of this.inflight.values()) {
          if (!session.acknowledged) session.controller.abort();
        }
      },
      abortInflight: () => {
        for (const session of this.inflight.values()) session.controller.abort();
      },
      onRegistered: (protocolVersion) => this.handleRegistered(protocolVersion),
      abortAfterMs: this.reconnectAbortMs,
      timers: this.timers,
    });
    await this.register();
    this.armKeepaliveStallTimer();
  }
  async applyInventory(next: DaemonConfig): Promise<void> {
    const wasPolicyBlocked = this.inventoryPolicyBlocked;
    const wasPolicyDrainPublished = this.inventoryPolicyDrainPublished;
    const previousRootsPolicy = this.worktrees.getAllowedRootsPolicy();
    // Validate the candidate inventory against its own roots. The prior fence
    // remains represented by `inventoryPolicyBlocked`, which refuses new
    // assignments and blocks pending hooks until replacement registration succeeds.
    try {
      await applyDaemonInventory(
        this.config,
        next,
        this.worktrees,
        async (candidate) => {
          // Advertise the validated inventory as available while retaining the local
          // assignment fence until that registration has been durably handed off.
          // A peer can otherwise queue an assignment while send() is still pending.
          await this.register({ config: candidate, inventoryPolicyBlocked: false });
        },
        () => {
          this.worktrees.clearAllowedRootsPolicy();
          this.workspaces.clearAllowedRootsPolicy();
          this.inventoryPolicyBlocked = false;
          this.inventoryPolicyDrainPublished = false;
        },
        this.workspaces,
      );
    } catch (error) {
      this.worktrees.restoreAllowedRootsPolicy(previousRootsPolicy);
      this.inventoryPolicyBlocked = wasPolicyBlocked;
      this.inventoryPolicyDrainPublished = wasPolicyDrainPublished;
      throw error;
    }
  }
  async blockAssignmentsForInvalidInventory(allowedRoots?: readonly string[]): Promise<void> {
    this.worktrees.setAllowedRootsPolicy(allowedRoots);
    this.workspaces.setAllowedRootsPolicy(allowedRoots);
    if (this.inventoryPolicyBlocked && this.inventoryPolicyDrainPublished) return;
    // Set the local gate before network I/O so an already-connected peer cannot assign work in
    // the interval before its durable registration is marked draining.
    this.inventoryPolicyBlocked = true;
    try {
      await this.register();
    } catch (error) {
      this.inventoryPolicyDrainPublished = false;
      throw error;
    }
  }
  async register({
    inventoryPolicyBlocked = this.inventoryPolicyBlocked,
    config = this.config,
  }: { inventoryPolicyBlocked?: boolean; config?: DaemonConfig } = {}): Promise<void> {
    const readiness = providerAccountReadiness(this.executionProfiles);
    const runningAttempts = this.confirmableOwnedAttempts();
    await registerDaemon(
      config,
      this.transport,
      runningAttempts.map((attempt) => attempt.sessionId),
      this.drainRequested || this.draining || inventoryPolicyBlocked,
      this.daemonIdentity,
      this.runtime,
      runningAttempts,
      this.executionProfiles,
    );
    if (inventoryPolicyBlocked) this.inventoryPolicyDrainPublished = true;
    this.advertisedProviderAccountReadiness = JSON.stringify(readiness);
  }
  /** Resolves true only when an actual host:keepalive frame was sent this tick. */
  async keepalive(): Promise<boolean> {
    if (
      JSON.stringify(providerAccountReadiness(this.executionProfiles)) !==
        this.advertisedProviderAccountReadiness &&
      !this.hasPendingAcknowledgement()
    ) {
      await this.register();
      // Protocol 2 waits for host:registered. A local register write is not
      // peer evidence — the same invariant as keepalive send() below.
      if (!this.requireKeepaliveAck) this.armKeepaliveStallTimer();
      return false;
    }
    this.retryPendingTerminalStatuses();
    // A successful command-start write only proves the frame reached the local
    // socket buffer. The control plane's acknowledgement can still be lost
    // while the connection remains healthy, so retry pending authorizations on
    // the next keepalive as well as after reconnect registration.
    this.retryPendingCommandStarts();
    this.retryPendingTerminalHookHandoffs();
    // Bounded: an outbound write stalled on a connection the transport still
    // considers open (registration wedged, dead epoch fencing) otherwise
    // leaves this promise pending forever — it never resolves *or* rejects,
    // so the caller's own failure handling never runs and "keepalive failed"
    // never logs, even during a real outage.
    await withTimeout(
      this.outbound.send({
        type: "host:keepalive",
        hostId: this.config.hostId,
        at: this.now(),
        runningSessions: this.ownedSessionIds(),
      }),
      this.keepaliveTimeoutMs,
      `keepalive timed out after ${this.keepaliveTimeoutMs}ms`,
      this.timers,
    );
    // Protocol 2+ waits for host:keepalive-ack. A resolved local write only
    // proves the bytes hit this process's socket buffer.
    if (!this.requireKeepaliveAck) this.armKeepaliveStallTimer();
    return true;
  }
  /**
   * (Re)start the deadline for "peer evidence must land within this window."
   * Left un-reset by a failed or timed-out attempt on purpose: only a
   * genuinely successful delivery (or a fresh registration, itself proof of
   * a live connection) counts as evidence the connection still works. Firing
   * abandons the current connection via forceReconnect and lets the
   * transport's own reconnect ladder take over — the same mechanism the
   * registration watchdog in ws-transport.ts uses for the same reason.
   */
  private armKeepaliveStallTimer(): void {
    if (this.keepaliveStallTimer) this.timers.clearTimeout(this.keepaliveStallTimer);
    this.keepaliveStallTimer = this.timers.setTimeout(() => {
      this.keepaliveStallTimer = undefined;
      this.onLog?.(`no successful keepalive in ${this.keepaliveStallMs}ms; forcing reconnect`);
      this.transport.forceReconnect?.(`no successful keepalive in ${this.keepaliveStallMs}ms`);
    }, this.keepaliveStallMs);
    this.keepaliveStallTimer.unref?.();
  }
  async beginDrain(): Promise<void> {
    if (this.draining) return;
    if (this.drainConfirmation) return this.drainConfirmation;
    this.drainRequested = true;
    this.drainConfirmation = new Promise<void>((resolve) => {
      this.resolveDrainConfirmation = resolve;
    });
    try {
      await this.sendDrainStatus();
    } catch (error) {
      // Keep the confirmation pending when the initial notification cannot
      // leave this daemon. In particular, a signal-triggered shutdown must
      // not reject and let Node exit while in-flight work is still running.
      // Retrying (or reconnect registration) resolves this exact promise.
      this.onLog?.(`drain notification failed: ${thrownMessage(error)}`);
    }
    // A lost acknowledgement needs the same retry path as a failed initial
    // write, and the promise above remains pending until either path commits.
    this.scheduleDrainRetry();
    // ...but not forever. With the control plane unreachable the retry loop never
    // commits, so beginDrain never settled and stop() hung — even with nothing in
    // flight. Give up announcing after the deadline and move on to draining the work
    // that is actually running; the control plane reclaims this host by heartbeat.
    this.drainDeadline = this.timers.setTimeout(() => {
      this.drainDeadline = undefined;
      if (!this.draining) {
        this.onLog?.(
          `drain not acknowledged within ${this.drainDeadlineMs}ms; continuing shutdown`,
        );
        this.confirmDrain();
      }
    }, this.drainDeadlineMs);
    this.drainDeadline.unref?.();
    return this.drainConfirmation;
  }

  isDraining(): boolean {
    return this.draining || this.inventoryPolicyBlocked || this.isDrainingExternal?.() === true;
  }
  inflightCount(): number {
    return this.inflight.size;
  }

  async waitForIdle(): Promise<void> {
    // In-flight entries remove themselves from the map when their owning
    // handleAssign call unwinds. Await the current work once: a resolved entry
    // can still be present briefly (and tests may install one to model a
    // superseded attempt), so repeatedly rereading this map can spin forever.
    await Promise.all([...this.inflight.values()].map((entry) => entry.work));
    // Handoff hooks can be the sole remaining work after an assignment has
    // already stopped.  Keep the transport alive through both the hook and
    // its current completion write; an unacknowledged completion remains
    // retriable after a later restart and must not make graceful shutdown wait
    // for the server's 24-hour retention window.
    while (true) {
      this.startPendingTerminalHookHandoffs();
      const activeWork = [
        ...[...this.pendingTerminalStatus.values()].map((pending) => pending.settlement),
        ...[...this.pendingTerminalHookHandoffs.values()].flatMap((pending) => [
          pending.work,
          // Completion delivery is not part of the shutdown fence. The
          // durable control-plane handoff remains recoverable after this
          // process exits, while awaiting a transport-buffered write would
          // create a cycle: daemonStop closes that transport only after this
          // idle wait. Outside shutdown, retain the ordinary delivery fence.
          ...(this.settleDeferredOnCompletion ? [] : [pending.completionSend]),
        ]),
      ].filter((work): work is Promise<void> => work !== undefined);
      if (activeWork.length === 0) return;
      await Promise.all(
        activeWork.map((work) =>
          work.then(
            () => undefined,
            () => undefined,
          ),
        ),
      );
    }
  }

  /**
   * Let active commands finish without treating shutdown as a terminal-hook
   * disposition. A deferred hook requires the control plane's durable ACK:
   * running it before that ACK can duplicate the retry's hook if the server
   * had accepted the retry but its acknowledgement was lost.
   */
  prepareForShutdown(): void {
    this.settleDeferredOnCompletion = true;
    for (const pending of this.pendingTerminalHookHandoffs.values()) {
      pending.completionController?.abort();
    }
    // A command-start acknowledgement can be lost after the control plane
    // commits it. Fail closed before waitForIdle() awaits the assignment; the
    // later stop() call repeats this idempotently for direct callers.
    for (const key of this.pendingCommandStarts.keys()) {
      this.finishCommandStart(key, false);
    }
    for (const pending of this.pendingTerminalStatus.values()) {
      if (!pending.settleDeferredTerminalHook) continue;
      pending.controller.abort();
      // Retain the status long enough for a concurrently delivered ACK to
      // settle the hook with its durable disposition. Otherwise release only
      // the local idle fence; recovery remains with the control plane.
      pending.resolveDeferredDisposition?.();
    }
  }

  async resumeFromDrain(): Promise<void> {
    if (this.drainRetry) this.timers.clearTimeout(this.drainRetry);
    if (this.drainDeadline) this.timers.clearTimeout(this.drainDeadline);
    this.drainRetry = undefined;
    this.drainDeadline = undefined;
    this.drainRequested = false;
    this.draining = false;
    this.settleDeferredOnCompletion = false;
    const resolve = this.resolveDrainConfirmation;
    this.resolveDrainConfirmation = undefined;
    this.drainConfirmation = undefined;
    resolve?.();
    await this.register();
  }

  stop(): void {
    this.prepareForShutdown();
    if (this.drainRetry) this.timers.clearTimeout(this.drainRetry);
    if (this.drainDeadline) this.timers.clearTimeout(this.drainDeadline);
    this.drainDeadline = undefined;
    if (this.keepaliveStallTimer) this.timers.clearTimeout(this.keepaliveStallTimer);
    this.keepaliveStallTimer = undefined;
    this.connectionEvents?.stop();
    for (const key of this.pendingCommandStarts.keys()) {
      this.finishCommandStart(key, false);
    }
    for (const [key, pending] of this.pendingTerminalStatus) {
      this.pendingTerminalStatus.delete(key);
      pending.controller.abort();
      // No durable terminal disposition arrived before the process exited.
      // The control plane owns recovery, so never infer local hook ownership
      // from shutdown.
      pending.resolveDeferredDisposition?.();
    }
    this.transport.close();
  }

  private async handleServerMessage(msg: HostWireMessage): Promise<void> {
    switch (msg.type) {
      case "host:registered":
        this.handleRegistered(msg.protocolVersion);
        return;
      case "host:drain":
        this.confirmDrain();
        return;
      case "host:draining":
        if (msg.hostId === this.config.hostId) this.confirmDrain();
        return;
      case "host:keepalive-ack":
        if (msg.hostId === this.config.hostId) this.armKeepaliveStallTimer();
        return;
      case "session:cancel":
        this.handleCancel(msg);
        return;
      case "session:acknowledged":
        this.handleAcknowledged(msg);
        return;
      case "session:command-start-acknowledged":
        this.handleCommandStartAcknowledged(msg);
        return;
      case "session:status-acknowledged":
        await this.handleStatusAcknowledged(msg);
        return;
      case "session:terminal-hook":
        await this.handleTerminalHookHandoff(msg);
        return;
      case "session:terminal-hook-acknowledged":
        this.pendingTerminalHookHandoffs.delete(msg.handoffId);
        return;
      case "session:assign":
        await this.handleAssign(msg);
        return;
      default:
        return;
    }
  }

  private handleRegistered(protocolVersion?: number): void {
    this.serverProtocolVersion = protocolVersion ?? 0;
    // A reconnect can negotiate an older peer than the connection that
    // created these checkpoints.  The older peer cannot acknowledge a
    // v4 command-start, so leave the authorization gate closed rather
    // than leaving the session-runner waiting forever.  This also wins
    // over any late ACK from the superseded connection; stop() and abort
    // use the same false settlement through finishCommandStart().
    if (this.serverProtocolVersion < COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION) {
      for (const key of this.pendingCommandStarts.keys()) {
        this.finishCommandStart(key, false);
      }
    }
    // A reconnect registration carrying `draining: true` is itself a
    // durable acknowledgement. This covers a lost drain reply.
    if (this.drainRequested) this.confirmDrain();
    // A fresh registration means a new/recovered socket: retry any
    // terminal status still unacknowledged now instead of waiting for
    // the next keepalive tick.
    this.retryPendingTerminalStatuses();
    this.retryPendingCommandStarts();
    this.retryPendingTerminalHookHandoffs();
    this.requireKeepaliveAck = (protocolVersion ?? 0) >= KEEPALIVE_ACK_PROTOCOL_VERSION;
    this.supportsSessionResult = (protocolVersion ?? 0) >= SESSION_RESULT_PROTOCOL_VERSION;
    // A fresh registration is itself proof this connection is live —
    // reset the same deadline a successful keepalive would.
    this.armKeepaliveStallTimer();
  }

  private abortSupersededAttempts(sessionId: string, attemptId: string): void {
    for (const entry of this.inflight.values()) {
      if (entry.sessionId !== sessionId || entry.attemptId === attemptId) continue;
      this.onLog?.(`superseded attempt ${entry.attemptId} aborted for ${sessionId}`);
      entry.controller.abort();
    }
  }

  /**
   * A fresh assignment is durable proof that any terminal report for an older
   * attempt is obsolete. The control plane can dispatch that replacement while
   * it is still writing the old report's status acknowledgement, so retaining
   * the old report here would make the daemon own two attempts for one logical
   * session in that delivery interval.
   */
  private discardSupersededTerminalStatuses(sessionId: string): Promise<void> | undefined {
    const settlements: Promise<void>[] = [];
    for (const [key, pending] of this.pendingTerminalStatus) {
      if (pending.message.sessionId !== sessionId) continue;
      pending.controller.abort();
      this.pendingTerminalStatus.delete(key);
      if (pending.settleDeferredTerminalHook) {
        settlements.push(
          pending
            .settleDeferredTerminalHook(false)
            .then(() => undefined)
            .finally(() => pending.resolveDeferredDisposition?.()),
        );
      } else {
        pending.resolveDeferredDisposition?.();
      }
    }
    return settlements.length > 0 ? Promise.all(settlements).then(() => undefined) : undefined;
  }

  private async waitForAbortedAttempts(sessionId: string, attemptId: string): Promise<void> {
    const pending = [...this.inflight.values()].filter(
      (entry) =>
        entry.sessionId === sessionId &&
        entry.attemptId !== attemptId &&
        entry.controller.signal.aborted,
    );
    await Promise.all(pending.map((entry) => entry.work.catch(() => undefined)));
  }

  /**
   * Wait for a preceding assignment's physical-target fence without retaining
   * a cancelled replacement behind it. The caller still leaves its own tail
   * chained to this fence, so a later assignment cannot overtake the work
   * that this cancelled waiter chose not to run.
   */
  private waitForTargetFence(targetWork: Promise<void>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (available: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        resolve(available);
      };
      const aborted = () => finish(false);
      signal.addEventListener("abort", aborted, { once: true });
      // Target fences normally only resolve, but an injected or future
      // predecessor must not strand this assignment's completion tail.
      void targetWork.then(
        () => finish(true),
        () => finish(true),
      );
      // Abort can race between the precondition above and listener setup.
      if (signal.aborted) aborted();
    });
  }

  private inflightFor(sessionId: string, attemptId: string | undefined): InflightSession[] {
    if (attemptId) {
      const current = this.inflight.get(inflightKey(sessionId, attemptId));
      return current ? [current] : [];
    }
    return [...this.inflight.values()].filter((entry) => entry.sessionId === sessionId);
  }

  private handleCancel(msg: Extract<HostWireMessage, { type: "session:cancel" }>): void {
    this.onLog?.(
      `cancel requested for ${msg.sessionId}${msg.attemptId ? ` attempt ${msg.attemptId}` : ""}`,
    );
    for (const current of this.inflightFor(msg.sessionId, msg.attemptId)) {
      current.controller.abort();
    }
  }

  /**
   * A readiness registration is also a reconciliation snapshot. Do not send
   * one while an assignment's durable ACK is outstanding: `register()` only
   * reports acknowledged attempts, so omitting the pending attempt could let
   * the control plane requeue it before its acknowledgement arrives.
   */
  private hasPendingAcknowledgement(): boolean {
    return [...this.inflight.values()].some((session) => !session.acknowledged);
  }

  private handleAcknowledged(
    msg: Extract<HostWireMessage, { type: "session:acknowledged" }>,
  ): void {
    for (const current of this.inflightFor(msg.sessionId, msg.attemptId)) {
      // Duplicate and late confirmations are harmless. The peer's durable
      // confirmation—not the outgoing write callback—permits execution.
      if (current.acknowledged || current.controller.signal.aborted) continue;
      current.acknowledged = true;
      const resolve = current.resolveAcknowledgement;
      current.resolveAcknowledgement = undefined;
      resolve?.();
    }
  }

  private handleCommandStartAcknowledged(
    msg: Extract<HostWireMessage, { type: "session:command-start-acknowledged" }>,
  ): void {
    this.finishCommandStart(inflightKey(msg.sessionId, msg.attemptId), true);
  }

  /**
   * Ask a protocol-4 control plane to durably authorize the primary CLI launch.
   * Legacy peers have no launch checkpoint, so they retain the existing behavior.
   */
  private authorizeCommandStart(assign: SessionAssign, signal?: AbortSignal): Promise<boolean> {
    if (!signal) return Promise.resolve(true);
    if (this.serverProtocolVersion < COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION) {
      return Promise.resolve(!signal.aborted);
    }
    if (signal.aborted) return Promise.resolve(false);
    const key = inflightKey(assign.sessionId, assign.attemptId);
    return new Promise<boolean>((resolve) => {
      const message: Extract<HostToServerMessage, { type: "session:command-start" }> = {
        type: "session:command-start",
        sessionId: assign.sessionId,
        worktreeId: assign.worktreeId,
        attemptId: assign.attemptId,
      };
      const pending: PendingCommandStart = {
        message,
        signal,
        resolve,
        onAbort: () => this.finishCommandStart(key, false),
        sending: false,
      };
      this.pendingCommandStarts.set(key, pending);
      signal.addEventListener("abort", pending.onAbort, { once: true });
      this.sendCommandStart(key, pending);
    });
  }

  private finishCommandStart(key: string, authorized: boolean): void {
    const pending = this.pendingCommandStarts.get(key);
    if (!pending) return;
    this.pendingCommandStarts.delete(key);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.resolve(authorized);
  }

  private sendCommandStart(key: string, pending: PendingCommandStart): void {
    if (
      pending.sending ||
      pending.signal.aborted ||
      this.pendingCommandStarts.get(key) !== pending ||
      this.serverProtocolVersion < COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION
    )
      return;
    pending.sending = true;
    void this.outbound
      .send(pending.message, { signal: pending.signal })
      .catch((error: unknown) => {
        this.onLog?.(
          `session:command-start send failed for ${pending.message.sessionId}: ${thrownMessage(error)}`,
        );
      })
      .finally(() => {
        pending.sending = false;
      });
  }

  private retryPendingCommandStarts(): void {
    for (const [key, pending] of this.pendingCommandStarts) {
      this.sendCommandStart(key, pending);
    }
  }

  /**
   * Attempts eligible for the control plane's reconnect-confirmation
   * handshake: acknowledged, unaborted in-flight assignments plus any
   * terminal status still awaiting acknowledgement. `register()`-only —
   * its consumer (`reconcileHostRunningSessions`) requires `ackReceivedAt`
   * to already be set server-side, which an unacknowledged assignment does
   * not have. A pending terminal status for a session the control plane has
   * already moved past `running` is safe to include: `ignoreStaleReconnectClaim`
   * drops it before the strict running/ack check runs.
   *
   * Deduplicated by `{sessionId, attemptId}`: `runAssign` records the pending
   * terminal status before its send settles, so the same attempt can briefly
   * appear in both `inflight` (not yet cleaned up by `handleAssign`'s
   * `finally`) and `pendingTerminalStatus`. A duplicate entry here makes
   * `parseHostMessage` reject the whole registration as invalid.
   */
  private confirmableOwnedAttempts(): { sessionId: string; attemptId: string }[] {
    const attempts = new Map<string, { sessionId: string; attemptId: string }>();
    for (const session of this.inflight.values()) {
      if (!session.acknowledged || session.controller.signal.aborted) continue;
      attempts.set(inflightKey(session.sessionId, session.attemptId), {
        sessionId: session.sessionId,
        attemptId: session.attemptId,
      });
    }
    for (const pending of this.pendingTerminalStatus.values()) {
      attempts.set(inflightKey(pending.message.sessionId, pending.message.attemptId), {
        sessionId: pending.message.sessionId,
        attemptId: pending.message.attemptId,
      });
    }
    return [...attempts.values()];
  }

  /**
   * Every session id this daemon currently claims, for keepalive-time
   * exclusion reconciliation: the control plane requeues anything running
   * on this host that is missing from this list, so it must never
   * under-report relative to `confirmableOwnedAttempts()`. Unlike that
   * method, this includes attempts still awaiting their assignment ack and
   * attempts mid-abort — an assignment is still owned until `runAssign`
   * actually returns, not once acknowledged.
   */
  private ownedSessionIds(): string[] {
    const ids = new Set<string>();
    for (const session of this.inflight.values()) ids.add(session.sessionId);
    for (const pending of this.pendingTerminalStatus.values()) ids.add(pending.message.sessionId);
    return [...ids];
  }

  private async handleStatusAcknowledged(
    msg: Extract<HostWireMessage, { type: "session:status-acknowledged" }>,
  ): Promise<void> {
    const acknowledge = (
      key: string,
      pending: PendingTerminalStatus,
    ): Promise<void> | undefined => {
      // Deferral is negotiated only with v4. A disposition-less acknowledgement
      // for such a pending hook fails closed as terminal rather than losing it.
      if (!pending.settleDeferredTerminalHook) {
        this.pendingTerminalStatus.delete(key);
        pending.resolveDeferredDisposition?.();
        return undefined;
      }
      const handoffExpiresAtMs =
        msg.terminalHookHandoffExpiresAt === undefined
          ? undefined
          : Date.parse(msg.terminalHookHandoffExpiresAt);
      const validHandoffExpiresAtMs = Number.isFinite(handoffExpiresAtMs)
        ? handoffExpiresAtMs
        : undefined;
      const syntheticV7Handoff =
        this.serverProtocolVersion >= TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION &&
        msg.terminalHookHandoffId !== undefined &&
        msg.retryAccepted !== true;
      // A v7 status acknowledgement is the control plane's durable handoff
      // lease. Validate it before retaining the checkout or starting its hook:
      // an expired/malformed lease cannot authorize new local side effects.
      if (
        syntheticV7Handoff &&
        (validHandoffExpiresAtMs === undefined || validHandoffExpiresAtMs <= Date.now())
      ) {
        this.pendingTerminalStatus.delete(key);
        pending.resolveDeferredDisposition?.();
        this.onLog?.(
          `terminal hook handoff ${msg.terminalHookHandoffId} has no usable control-plane expiry; ` +
            "refusing deferred settlement",
        );
        return undefined;
      }
      // Keep the entry indexed during settlement: an overlapping durable
      // handoff must find this exact promise rather than run the hook again.
      if (pending.settlement) return pending.settlement;
      const settlementResult =
        pending.settlementResult ??
        pending.settleDeferredTerminalHook(
          msg.retryAccepted !== true,
          syntheticV7Handoff ? validHandoffExpiresAtMs : undefined,
        );
      pending.settlementResult = settlementResult;
      const settlement = settlementResult
        .then((result) => {
          if (msg.terminalHookHandoffId && msg.retryAccepted !== true) {
            const existing = this.pendingTerminalHookHandoffs.get(msg.terminalHookHandoffId);
            if (existing) {
              if (result !== undefined) existing.result = result;
              existing.complete = true;
              // The inbound handoff's reconciliation owns the first completion
              // send; sending here too races a fast local transport and can
              // duplicate that completion before its acknowledgement arrives.
              return;
            }
            const handoff: PendingTerminalHookHandoff = {
              ...(handoffExpiresAtMs !== undefined && Number.isFinite(handoffExpiresAtMs)
                ? { expiresAtMs: handoffExpiresAtMs }
                : {}),
              message: {
                type: "session:terminal-hook",
                handoffId: msg.terminalHookHandoffId,
                sessionId: pending.message.sessionId,
                repositoryId: "",
                worktreeId: pending.message.worktreeId,
                status: pending.message.status as Extract<
                  import("@auto-harness/shared").SessionStatus,
                  "completed" | "failed" | "cancelled" | "timed_out"
                >,
                ...(msg.terminalHookHandoffExpiresAt !== undefined &&
                Number.isFinite(handoffExpiresAtMs)
                  ? { expiresAt: msg.terminalHookHandoffExpiresAt }
                  : {}),
                ...(pending.message.errorCode !== undefined
                  ? { errorCode: pending.message.errorCode }
                  : {}),
              },
              firstAttemptedAtMs: Date.now(),
              complete: true,
              executing: false,
              sending: false,
              ...(result !== undefined ? { result } : {}),
            };
            this.pendingTerminalHookHandoffs.set(msg.terminalHookHandoffId, handoff);
            this.sendTerminalHookHandoffCompletion(handoff);
          }
        })
        .finally(() => {
          if (this.pendingTerminalStatus.get(key) === pending) {
            this.pendingTerminalStatus.delete(key);
          }
          pending.resolveDeferredDisposition?.();
        });
      pending.settlement = settlement;
      return settlement;
    };
    if (msg.attemptId) {
      const key = inflightKey(msg.sessionId, msg.attemptId);
      const pending = this.pendingTerminalStatus.get(key);
      const settled = pending ? acknowledge(key, pending) : undefined;
      if (settled) await settled;
      return;
    }
    for (const [key, pending] of this.pendingTerminalStatus) {
      if (pending.message.sessionId === msg.sessionId) {
        const settled = acknowledge(key, pending);
        if (settled) await settled;
      }
    }
  }

  /**
   * A v7 peer assigns this only after a prior daemon died. It deliberately
   * reuses the current inventory and root policy; the control plane never
   * sends executable paths. Its absolute control-plane deadline bounds both
   * hook execution and completion retry.
   */
  private async handleTerminalHookHandoff(
    msg: Extract<HostWireMessage, { type: "session:terminal-hook" }>,
  ): Promise<void> {
    if (this.serverProtocolVersion < TERMINAL_HOOK_HANDOFF_EXPIRY_PROTOCOL_VERSION) return;
    const expiresAtMs = Date.parse(msg.expiresAt ?? "");
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return;
    const existing = this.pendingTerminalHookHandoffs.get(msg.handoffId);
    if (existing) {
      if (existing.complete) this.sendTerminalHookHandoffCompletion(existing);
      return;
    }
    this.expirePendingTerminalHookHandoffs(Date.now());
    if (this.pendingTerminalHookHandoffs.size >= this.pendingTerminalHookHandoffMaxCount) {
      this.onLog?.(
        `terminal hook handoff retry buffer full (${String(this.pendingTerminalHookHandoffMaxCount)}); ` +
          `deferring ${msg.sessionId} until a fresh registration`,
      );
      return;
    }
    const pending: PendingTerminalHookHandoff = {
      message: msg,
      expiresAtMs,
      complete: false,
      executing: false,
      sending: false,
    };
    this.pendingTerminalHookHandoffs.set(msg.handoffId, pending);
    // A reconnect can receive the durable replacement handoff while this
    // process still owns the original terminal status. That status's retained
    // checkout tail waits for its hook disposition; let it finish its one
    // hook first and merely settle the replacement handoff, never duplicate it.
    const reconciled = await this.reconcilePendingTerminalStatusForHandoff(msg.sessionId);
    if (reconciled.matched) {
      if (reconciled.result) pending.result = reconciled.result;
      pending.complete = true;
      this.sendTerminalHookHandoffCompletion(pending);
      return;
    }
    this.startTerminalHookHandoff(pending);
  }

  private activeAssignmentCount(): number {
    return [...this.inflight.values()].filter(
      (entry) =>
        !entry.controller.signal.aborted &&
        !this.pendingTerminalStatus.has(inflightKey(entry.sessionId, entry.attemptId)),
    ).length;
  }

  private startTerminalHookHandoff(pending: PendingTerminalHookHandoff): void {
    if (
      this.settleDeferredOnCompletion ||
      pending.complete ||
      pending.executing ||
      this.pendingTerminalHookHandoffs.get(pending.message.handoffId) !== pending ||
      this.activeAssignmentCount() + this.activeTerminalHookHandoffs >=
        this.executionProfiles.maxConcurrentAssignments
    )
      return;
    pending.executing = true;
    this.activeTerminalHookHandoffs += 1;
    const work = this.runTerminalHookHandoff(pending).finally(() => {
      pending.executing = false;
      pending.work = undefined;
      this.activeTerminalHookHandoffs -= 1;
    });
    pending.work = work;
    void work;
  }

  private async runTerminalHookHandoff(pending: PendingTerminalHookHandoff): Promise<void> {
    const expiresAtMs = pending.expiresAtMs;
    if (expiresAtMs === undefined) return;
    const msg = pending.message;
    const targetKey =
      msg.worktreeId === null
        ? `main\0${msg.repositoryId}`
        : `worktree\0${msg.repositoryId}\0${msg.worktreeId}`;
    const previousTargetWork = this.worktreeAssignmentTails.get(targetKey);
    let resolveTargetWork!: () => void;
    const targetWork = new Promise<void>((resolve) => {
      resolveTargetWork = resolve;
    });
    this.worktreeAssignmentTails.set(targetKey, targetWork);
    try {
      if (previousTargetWork) await previousTargetWork.catch(() => undefined);
      // This hook may have spent its entire control-plane lease behind a
      // preceding session on the same physical target. Drop it here rather
      // than merely returning: waitForIdle() restarts incomplete handoffs,
      // which would otherwise turn an expired waiter into an endless
      // microtask loop once shutdown has stopped keepalives.
      if (Date.now() >= expiresAtMs) {
        this.expirePendingTerminalHookHandoffs(Date.now());
        return;
      }
      if (msg.worktreeId === null) {
        if (!(await this.worktrees.acquireMain(msg.repositoryId))) {
          throw new Error(`main checkout unavailable for terminal hook ${msg.sessionId}`);
        }
        try {
          const result = await this.runTerminalHookForClaim(
            msg,
            await this.worktrees.mainClaim(msg.repositoryId),
            expiresAtMs,
          );
          if (result) pending.result = result;
        } finally {
          this.worktrees.releaseMain(msg.repositoryId);
        }
      } else {
        const claim = await this.worktrees.claim(msg.repositoryId, msg.worktreeId);
        try {
          const result = await this.runTerminalHookForClaim(msg, claim, expiresAtMs);
          if (result) pending.result = result;
        } finally {
          this.worktrees.release(msg.worktreeId);
        }
      }
    } catch (error) {
      // A missing/changed checkout or policy is a fail-closed no-op: the
      // recovery owner is nevertheless settled, so it cannot retain work
      // indefinitely while the host remains healthy.
      this.onLog?.(`terminal hook handoff failed for ${msg.sessionId}: ${thrownMessage(error)}`);
    } finally {
      resolveTargetWork();
      if (this.worktreeAssignmentTails.get(targetKey) === targetWork) {
        this.worktreeAssignmentTails.delete(targetKey);
      }
    }
    pending.complete = true;
    this.sendTerminalHookHandoffCompletion(pending);
  }

  private async runTerminalHookForClaim(
    msg: PendingTerminalHookHandoffMessage,
    claim: ClaimedWorktree,
    expiresAtMs: number,
  ): Promise<import("@auto-harness/shared").SessionResult | undefined> {
    const current = await claim.currentHookTarget();
    const scriptPath = current?.repository.terminalHookScript;
    if (!current) return undefined;
    const mappedGitHubApp = this.githubApp?.repositories.has(msg.repositoryId) ?? false;
    let isolatedGitHubConfigDir: string | undefined;
    let terminalEnvironment = mappedGitHubApp
      ? withoutAmbientGitHubTokens(this.childEnvSource)
      : this.childEnvSource;
    let terminalRunner = this.processRunner;
    let effectiveExpiresAtMs = expiresAtMs;
    const credentialController = new AbortController();
    let credentialTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (mappedGitHubApp) {
        const credentialTimeoutMs = Math.min(60_000, expiresAtMs - Date.now());
        if (credentialTimeoutMs <= 0) credentialController.abort();
        else {
          credentialTimer = this.timers.setTimeout(
            () => credentialController.abort(),
            credentialTimeoutMs,
          );
        }
        isolatedGitHubConfigDir = await mkdtemp(join(tmpdir(), "auto-harness-gh-config-"));
        terminalEnvironment = withIsolatedGitHubConfigDir(
          terminalEnvironment,
          isolatedGitHubConfigDir,
        );
        const token = await mintInstallationToken(
          this.githubApp!,
          msg.repositoryId,
          credentialController.signal,
        );
        if (!token || token.expiresAtMs - Date.now() <= GITHUB_APP_TOKEN_MARGIN_MS) {
          this.onLog?.(`GitHub App credential provisioning failed for ${msg.sessionId}`);
          return undefined;
        }
        effectiveExpiresAtMs = Math.min(
          expiresAtMs,
          token.expiresAtMs - GITHUB_APP_TOKEN_MARGIN_MS,
        );
        if (effectiveExpiresAtMs <= Date.now()) return undefined;
        terminalEnvironment = withInstallationToken(terminalEnvironment, this.githubApp!, token);
        terminalRunner = new SecretRedactingProcessRunner(this.processRunner, token.token);
      }
      if (scriptPath) {
        const remainingMs = effectiveExpiresAtMs - Date.now();
        if (remainingMs <= 0) return undefined;
        await runTerminalHook(terminalRunner, {
          scriptPath,
          cwd: current.cwd,
          sessionId: msg.sessionId,
          status: msg.status,
          worktreePath: current.cwd,
          childEnvSource: terminalEnvironment,
          timeoutMs: Math.min(60_000, remainingMs),
          ...(current.allowedRoots?.length ? { allowedRoots: current.allowedRoots } : {}),
          ...(msg.errorCode !== undefined ? { errorCode: msg.errorCode } : {}),
          ...(msg.ref !== undefined ? { ref: msg.ref } : {}),
          ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
        });
      }
      return await collectSessionResult({
        runner: terminalRunner,
        cwd: current.cwd,
        status: msg.status,
        environment: terminalEnvironment,
        deadlineAtMs: effectiveExpiresAtMs,
      });
    } catch (error) {
      if (mappedGitHubApp) {
        this.onLog?.(`GitHub App credential provisioning failed for ${msg.sessionId}`);
        return undefined;
      }
      throw error;
    } finally {
      if (credentialTimer !== undefined) this.timers.clearTimeout(credentialTimer);
      if (isolatedGitHubConfigDir) {
        try {
          await rm(isolatedGitHubConfigDir, { force: true, recursive: true });
        } catch (error) {
          this.onLog?.(
            `failed to remove isolated GitHub config directory: ${thrownMessage(error)}`,
          );
        }
      }
    }
  }

  private sendTerminalHookHandoffCompletion(pending: PendingTerminalHookHandoff): void {
    if (
      pending.sending ||
      !pending.complete ||
      this.pendingTerminalHookHandoffs.get(pending.message.handoffId) !== pending
    )
      return;
    pending.sending = true;
    const completionController = new AbortController();
    pending.completionController = completionController;
    const completionSend = this.outbound
      .send(
        {
          type: "session:terminal-hook-complete",
          sessionId: pending.message.sessionId,
          handoffId: pending.message.handoffId,
          ...(this.serverProtocolVersion >= DEFERRED_TERMINAL_RESULT_PROTOCOL_VERSION &&
          pending.result !== undefined
            ? { result: pending.result }
            : {}),
        },
        { signal: completionController.signal },
      )
      .catch((error: unknown) => {
        this.onLog?.(
          `terminal hook handoff completion send failed for ${pending.message.sessionId}: ${thrownMessage(error)}`,
        );
      })
      .finally(() => {
        pending.sending = false;
        pending.completionSend = undefined;
        pending.completionController = undefined;
      });
    pending.completionSend = completionSend;
    void completionSend;
  }

  private retryPendingTerminalHookHandoffs(): void {
    this.expirePendingTerminalHookHandoffs(Date.now());
    for (const pending of this.pendingTerminalHookHandoffs.values()) {
      if (pending.complete) this.sendTerminalHookHandoffCompletion(pending);
    }
    this.startPendingTerminalHookHandoffs();
  }

  private startPendingTerminalHookHandoffs(): void {
    for (const pending of this.pendingTerminalHookHandoffs.values()) {
      if (!pending.complete) this.startTerminalHookHandoff(pending);
    }
  }

  private expirePendingTerminalHookHandoffs(nowMs: number): void {
    for (const [handoffId, pending] of this.pendingTerminalHookHandoffs) {
      if (
        pending.expiresAtMs === undefined
          ? nowMs - (pending.firstAttemptedAtMs ?? nowMs) <= this.pendingTerminalHookHandoffMaxAgeMs
          : nowMs < pending.expiresAtMs
      )
        continue;
      this.pendingTerminalHookHandoffs.delete(handoffId);
      this.onLog?.(
        `terminal hook handoff completion expired for ${pending.message.sessionId} ` +
          (pending.expiresAtMs === undefined
            ? `after ${String(this.pendingTerminalHookHandoffMaxAgeMs)}ms`
            : "at the control-plane expiry"),
      );
    }
  }

  /**
   * A same-process recovery handoff is proof that this daemon still has the
   * original terminal owner. Deferred statuses release their target only once
   * their hook has run; ordinary statuses already ran it. Keep the status for
   * its own ACK retry, but settle the handoff without executing a second hook.
   */
  private async reconcilePendingTerminalStatusForHandoff(sessionId: string): Promise<{
    matched: boolean;
    result?: import("@auto-harness/shared").SessionResult;
  }> {
    const matching = [...this.pendingTerminalStatus.values()].filter(
      (pending) => pending.message.sessionId === sessionId,
    );
    if (matching.length === 0) return { matched: false };
    const results = await Promise.all(
      matching.map(async (pending) => {
        if (pending.settleDeferredTerminalHook) {
          const settlement = pending.settlementResult ?? pending.settleDeferredTerminalHook(true);
          return await settlement.finally(() => pending.resolveDeferredDisposition?.());
        } else {
          pending.resolveDeferredDisposition?.();
          return undefined;
        }
      }),
    );
    const result = results.find((candidate) => candidate !== undefined);
    return { matched: true, ...(result ? { result } : {}) };
  }

  /**
   * Re-send every terminal status not yet acknowledged. A completed WebSocket
   * write is not delivery (see ws-transport.ts), so success here does not
   * remove the entry — only `session:status-acknowledged` does. Fire-and-forget
   * on purpose: a retained send can sit undelivered for the whole length of an
   * outage (see ws-outbound-buffer.ts), and this runs on every keepalive tick,
   * so it must never block that tick's own `host:keepalive` write. The `sending`
   * guard stops a still-undelivered attempt from being re-enqueued as a second,
   * duplicate retained frame on the next tick. Dropped after `pendingStatusMaxAgeMs`.
   */
  private retryPendingTerminalStatuses(): void {
    const nowMs = Date.now();
    let issuedThisTick = 0;
    // Snapshot first: entries retried below are moved to the back of the
    // live map for fairness (see comment below), which must not affect this
    // single pass over what was pending at the start of this call.
    for (const [key, pending] of Array.from(this.pendingTerminalStatus)) {
      if (nowMs - pending.firstAttemptedAtMs > this.pendingStatusMaxAgeMs) {
        this.onLog?.(
          `giving up on unacknowledged terminal status for ${pending.message.sessionId} ` +
            `after ${String(this.pendingStatusMaxAgeMs)}ms`,
        );
        // Cancels a still-buffered retained frame instead of leaving it
        // queued to be transmitted whenever the connection recovers.
        this.pendingTerminalStatus.delete(key);
        pending.controller.abort();
        if (pending.settleDeferredTerminalHook) {
          void pending
            .settleDeferredTerminalHook(true)
            .catch((error: unknown) => {
              this.onLog?.(
                `deferred terminal hook failed for ${pending.message.sessionId}: ${thrownMessage(error)}`,
              );
            })
            .finally(() => pending.resolveDeferredDisposition?.());
        } else {
          pending.resolveDeferredDisposition?.();
        }
        continue;
      }
      if (pending.sending) continue;
      if (issuedThisTick >= this.statusRetriesPerTick) continue;
      issuedThisTick += 1;
      // Rotate to the back of iteration order so a backlog larger than
      // statusRetriesPerTick is retried fairly across ticks instead of
      // always favoring the same entries and starving the rest.
      this.pendingTerminalStatus.delete(key);
      this.pendingTerminalStatus.set(key, pending);
      pending.sending = true;
      void this.outbound
        .send(pending.message, { signal: pending.controller.signal })
        .catch((error: unknown) => {
          this.onLog?.(
            `terminal status retry failed for ${pending.message.sessionId}: ` +
              `${thrownMessage(error)}`,
          );
        })
        .finally(() => {
          pending.sending = false;
        });
    }
  }

  private async handleAssign(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
  ): Promise<void> {
    if (this.isDraining()) {
      this.onLog?.(`draining: refused assign ${msg.sessionId}`);
      return;
    }
    if (!this.runtime?.gitReady && (msg.sessionType as string | undefined) !== "workspace") {
      this.onLog?.(`git not ready: refused assign ${msg.sessionId}`);
      return;
    }
    if (msg.providerAccountId) {
      const profile = resolveExecutionProfile(this.executionProfiles, msg.providerAccountId);
      if (!profile || !executionProfileReady(profile)) {
        this.onLog?.(
          `execution profile unavailable: refused assign ${msg.sessionId} account ${msg.providerAccountId}`,
        );
        return;
      }
    }

    const key = inflightKey(msg.sessionId, msg.attemptId);
    if (this.inflight.has(key)) {
      this.onLog?.(`duplicate assign ignored for ${msg.sessionId} attempt ${msg.attemptId}`);
      return;
    }

    this.abortSupersededAttempts(msg.sessionId, msg.attemptId);
    // A terminal result has already stopped executing, even though its
    // `runAssign` remains in-flight while its status is delivered. It must not
    // consume the bounded CLI capacity during that acknowledgement interval;
    // `worktreeAssignmentTails` below still serializes a retained checkout
    // claim before another session may use the same physical worktree.
    const live = this.activeAssignmentCount();
    if (live + this.activeTerminalHookHandoffs >= this.executionProfiles.maxConcurrentAssignments) {
      this.onLog?.(`session capacity reached: refused assign ${msg.sessionId}`);
      return;
    }
    // Protocol-v6 checkout failures must retain their terminal status even
    // when the ordinary retry buffer is full, because its durable disposition
    // decides whether the terminal hook runs. Reserve at most one exceptional
    // slot per execution slot so those mandatory entries remain bounded. A
    // replacement for the same session will discard its older entries below,
    // so they do not consume its reservation.
    const retainedForOtherSessions = [...this.pendingTerminalStatus.values()].filter(
      (pending) => pending.message.sessionId !== msg.sessionId,
    ).length;
    if (
      this.serverProtocolVersion >= COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION &&
      retainedForOtherSessions + live >=
        this.pendingStatusMaxCount + this.executionProfiles.maxConcurrentAssignments
    ) {
      this.onLog?.(`terminal status retry capacity reached: refused assign ${msg.sessionId}`);
      return;
    }

    const controller = new AbortController();
    // Install the slot before the first await so an immediate peer reply is
    // tied to this exact assignment.
    const entry: InflightSession = {
      sessionId: msg.sessionId,
      attemptId: msg.attemptId,
      controller,
      work: Promise.resolve(),
      acknowledged: false,
    };
    this.inflight.set(key, entry);
    const settleSuperseded = this.discardSupersededTerminalStatuses(msg.sessionId);
    const targetKey = assignmentTargetKey(msg);
    const previousTargetWork = this.worktreeAssignmentTails.get(targetKey);
    let resolveTargetWork!: () => void;
    const targetWork = new Promise<void>((resolve) => {
      resolveTargetWork = resolve;
    });
    this.worktreeAssignmentTails.set(targetKey, targetWork);
    const work = (async () => {
      try {
        const usesCommandStartAuthorization =
          this.serverProtocolVersion >= COMMAND_START_AUTHORIZATION_PROTOCOL_VERSION;
        // The control plane's ACK deadline governs v4 ownership, not physical
        // execution. Confirm the v4 assignment before any retained worktree
        // claim can delay it; the fences below still prevent its runner from
        // touching the target until the predecessor has released. Older peers
        // retain their send-after-local-admission behavior.
        if (
          usesCommandStartAuthorization &&
          !(await this.acknowledgeAssignment(msg, controller.signal))
        )
          return;
        // A replacement for this logical session must first settle its old
        // retry disposition. That releases the preceding retained claim and
        // prevents a same-session retry from waiting on itself below.
        if (
          settleSuperseded &&
          !(await this.waitForTargetFence(settleSuperseded, controller.signal))
        )
          return;
        // A different logical session on this target waits until all work for
        // the preceding assignment has returned. `runAssign` includes its v4
        // disposition wait, so this fence covers retained checkout claims.
        if (
          previousTargetWork &&
          !(await this.waitForTargetFence(previousTargetWork, controller.signal))
        )
          return;
        if (
          !usesCommandStartAuthorization &&
          !(await this.acknowledgeAssignment(msg, controller.signal))
        )
          return;
        if (!controller.signal.aborted) await this.runAssign(msg, controller.signal);
      } finally {
        // A cancelled waiter may return before its predecessor. Keep this
        // tail pending until both are clear, otherwise a third assignment
        // could overtake the predecessor's still-retained physical claim.
        const finishTargetWork = () => {
          resolveTargetWork();
          if (this.worktreeAssignmentTails.get(targetKey) === targetWork) {
            this.worktreeAssignmentTails.delete(targetKey);
          }
        };
        if (previousTargetWork) {
          void previousTargetWork.then(finishTargetWork, finishTargetWork);
        } else {
          finishTargetWork();
        }
      }
    })();
    entry.work = work;
    try {
      await work;
    } finally {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    }
  }

  private confirmDrain(): void {
    this.draining = true;
    this.drainRequested = true;
    if (this.drainRetry) this.timers.clearTimeout(this.drainRetry);
    this.drainRetry = undefined;
    if (this.drainDeadline) this.timers.clearTimeout(this.drainDeadline);
    this.drainDeadline = undefined;
    const resolve = this.resolveDrainConfirmation;
    this.resolveDrainConfirmation = undefined;
    resolve?.();
  }

  private async sendDrainStatus(): Promise<void> {
    await this.outbound.send({
      type: "host:status",
      hostId: this.config.hostId,
      draining: true,
    });
  }

  private scheduleDrainRetry(): void {
    if (this.draining || this.drainRetry) return;
    this.drainRetry = this.timers.setTimeout(() => {
      this.drainRetry = undefined;
      void this.sendDrainStatus()
        .catch((error: unknown) => {
          this.onLog?.(`drain notification retry failed: ${thrownMessage(error)}`);
        })
        .finally(() => this.scheduleDrainRetry());
    }, this.drainRetryMs);
  }

  private async acknowledgeAssignment(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
    signal: AbortSignal,
  ): Promise<boolean> {
    const workspace = (msg.sessionType as string | undefined) === "workspace";
    const workspaceFields = msg as typeof msg & {
      workspacePoolId?: unknown;
      workspaceSlotId?: unknown;
    };
    // Scheduled assignments deliberately use the repository's main checkout;
    // ordinary assignments name a worktree; workspace assignments name a slot.
    if (
      (!workspace && (msg.worktreeId === null) !== (msg.sessionType === "scheduled")) ||
      (workspace &&
        (msg.worktreeId !== null ||
          typeof workspaceFields.workspacePoolId !== "string" ||
          !workspaceFields.workspacePoolId ||
          typeof workspaceFields.workspaceSlotId !== "string" ||
          !workspaceFields.workspaceSlotId))
    ) {
      throw new Error(
        workspace
          ? `workspace assignment ${msg.sessionId} is missing a workspace slot`
          : msg.worktreeId === null
            ? `assignment ${msg.sessionId} is missing a worktree`
            : `scheduled assignment ${msg.sessionId} must use the main checkout`,
      );
    }
    await this.outbound.send(
      {
        type: "session:ack",
        sessionId: msg.sessionId,
        worktreeId: msg.worktreeId,
        attemptId: msg.attemptId,
      },
      { signal },
    );
    return this.waitForAcknowledgement(msg.sessionId, msg.attemptId, signal);
  }

  private async runAssign(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.waitForAbortedAttempts(msg.sessionId, msg.attemptId);
    const route = resolvedRouteMetadata(msg);
    if (route.targetIndex !== undefined || route.commandId || route.providerAccountId) {
      this.onLog?.(
        `resolved route for ${msg.sessionId}: target=${route.targetIndex ?? "?"}` +
          `${route.commandId ? ` command=${route.commandId}` : ""}` +
          `${route.providerAccountId ? ` providerAccount=${route.providerAccountId}` : ""}`,
      );
    }

    const assign = sessionAssignFromWire(msg);

    const result: SessionRunResult = await this.runner.run(assign, {
      signal,
      initialLogSeq: this.nextLogSeq.get(msg.sessionId) ?? 0,
      deferCheckoutFetchFailureHook:
        this.serverProtocolVersion >= DEFERRED_TERMINAL_RESULT_PROTOCOL_VERSION,
    });
    let settleDeferredTerminalHook = result.settleDeferredTerminalHook;
    let terminalErrorCode = result.errorCode;

    if (result.logs.length > 0) {
      this.nextLogSeq.set(msg.sessionId, result.logs.at(-1)!.seq + 1);
    }
    const assignedWorkspaceSlotId =
      msg.sessionType === "workspace" ? msg.workspaceSlotId : undefined;
    const statusMessage: Extract<HostToServerMessage, { type: "session:status" }> = {
      type: "session:status",
      sessionId: msg.sessionId,
      worktreeId: msg.worktreeId,
      attemptId: msg.attemptId,
      status: result.status,
      exitCode: result.exitCode,
      ...(terminalErrorCode !== undefined ? { errorCode: terminalErrorCode } : {}),
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      ...(result.cliResumeRef !== undefined ? { cliResumeRef: result.cliResumeRef } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(this.supportsSessionResult && result.result !== undefined && !settleDeferredTerminalHook
        ? { result: result.result }
        : {}),
      ...(settleDeferredTerminalHook ? { deferTerminalHookResult: true } : {}),
      ...(result.workspaceSlotId !== undefined
        ? { workspaceSlotId: result.workspaceSlotId }
        : typeof assignedWorkspaceSlotId === "string"
          ? { workspaceSlotId: assignedWorkspaceSlotId }
          : {}),
      ...(result.workspaceSlotError !== undefined
        ? { workspaceSlotError: result.workspaceSlotError }
        : {}),
    };
    // Record the completed result before waiting for the output queue. A
    // disconnected retained log can keep flush() pending beyond reconnect
    // grace; registration must still claim this completed attempt so the
    // control plane does not requeue it after the in-flight entry is aborted.
    // The status is sent only after flush below, retaining log-before-terminal
    // order. Keeping the pending send marked in progress prevents reconnect
    // retries from duplicating the original send while flush is still pending.
    const pendingKey = inflightKey(msg.sessionId, msg.attemptId);
    const controller = new AbortController();
    const needsDeferredDisposition = settleDeferredTerminalHook !== undefined;
    let resolveDeferredDisposition: (() => void) | undefined;
    const deferredDisposition = needsDeferredDisposition
      ? new Promise<void>((resolve) => {
          resolveDeferredDisposition = resolve;
        })
      : undefined;
    if (
      this.pendingTerminalStatus.size >= this.pendingStatusMaxCount &&
      !settleDeferredTerminalHook
    ) {
      // A control plane that never sends session:status-acknowledged (e.g. not yet
      // upgraded to support it) would otherwise grow this set without bound until a
      // keepalive/registration is rejected as invalid for exceeding the wire limit.
      // Degrade ordinary terminal delivery to the old fire-once behavior
      // instead of retaining this one. A v6 checkout failure is always
      // retained even beyond this cap because its durable retry disposition
      // owns whether the terminal hook runs. Those exceptional entries stay
      // bounded by the admission reservation in handleAssign.
      this.onLog?.(
        `terminal status retry buffer full (${String(this.pendingStatusMaxCount)}); ` +
          `not retrying ${msg.sessionId} if this send is lost`,
      );
    } else {
      this.pendingTerminalStatus.set(pendingKey, {
        message: statusMessage,
        firstAttemptedAtMs: Date.now(),
        sending: true,
        controller,
        ...(settleDeferredTerminalHook ? { settleDeferredTerminalHook } : {}),
        ...(resolveDeferredDisposition ? { resolveDeferredDisposition } : {}),
      });
    }
    await this.outbound.flush();
    await this.outbound
      .send(statusMessage, { signal: controller.signal })
      .catch((error: unknown) => {
        this.onLog?.(
          `session:status send failed for ${msg.sessionId}, will retry via keepalive: ` +
            `${thrownMessage(error)}`,
        );
      })
      .finally(() => {
        const pending = this.pendingTerminalStatus.get(pendingKey);
        if (pending) pending.sending = false;
      });
    if (deferredDisposition) {
      if (!this.pendingTerminalStatus.has(pendingKey)) {
        await settleDeferredTerminalHook!(true);
        resolveDeferredDisposition?.();
      } else if (this.settleDeferredOnCompletion) {
        // Shutdown must not manufacture a terminal disposition. The retained
        // status remains recoverable by the control plane, while this active
        // assignment may now leave the local idle fence.
        resolveDeferredDisposition?.();
      }
      await deferredDisposition;
    }
  }

  private async emitLog(chunk: SessionLogChunk): Promise<void> {
    await sendDaemonLog(this.outbound, this.onLog, chunk);
  }

  private async waitForAcknowledgement(
    sessionId: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const inflight = this.inflight.get(inflightKey(sessionId, attemptId));
    if (!inflight || inflight.controller.signal !== signal || signal.aborted) return false;
    if (inflight.acknowledged) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (acknowledged: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", aborted);
        if (timeout) this.timers.clearTimeout(timeout);
        if (inflight.resolveAcknowledgement === confirmed) {
          inflight.resolveAcknowledgement = undefined;
        }
        resolve(acknowledged);
      };
      const confirmed = () => finish(true);
      const aborted = () => finish(false);
      inflight.resolveAcknowledgement = confirmed;
      signal.addEventListener("abort", aborted, { once: true });
      timeout = this.timers.setTimeout(() => {
        this.onLog?.(`acknowledgement confirmation timed out for ${sessionId}`);
        inflight.controller.abort();
        finish(false);
      }, this.ackConfirmationMs);
      // A loopback peer can reply synchronously between the earlier state
      // check and installing this resolver.
      if (inflight.acknowledged) confirmed();
    });
  }
}

export { createLoopbackTransport } from "./loopback-transport.ts";
