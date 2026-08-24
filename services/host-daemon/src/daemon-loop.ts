/* eslint-disable max-lines -- ordered daemon lifecycle belongs in this single loop. */
import { randomUUID } from "node:crypto";
import type { HostRuntimeReport, HostWireMessage, SessionLogChunk } from "@auto-harness/shared";
import type { DaemonTransport } from "./daemon-transport-types.ts";
import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { PtyProcessRunner } from "./pty-runner.ts";
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
  resolveExecutionProfile,
  type ExecutionProfiles,
} from "./execution-profiles.ts";
import { resolvedRouteMetadata, sessionAssignFromWire } from "./session-assign.ts";
import type { SessionRunResult } from "./session-runner.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { probeGitReadiness } from "./git-readiness.ts";
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

function inflightKey(sessionId: string, attemptId: string): string {
  return `${sessionId}\0${attemptId}`;
}
export class DaemonLoop {
  private readonly runner: SessionRunner;
  private readonly worktrees: WorktreeManager;
  private readonly inflight = new Map<string, InflightSession>();
  private readonly nextLogSeq = new Map<string, number>();
  private draining = false;
  /** Set before a drain write so reconnect registration cannot reopen capacity. */
  private drainRequested = false;
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
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private readonly daemonIdentity: DaemonRuntimeIdentity;
  private readonly processRunner: ProcessRunner;
  private readonly executionProfiles: ExecutionProfiles;
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
    this.timers = options.timers ?? globalThis;
    this.outbound = new OutboundQueue(this.transport, (line) => this.onLog?.(line));
    const processRunner = options.processRunner ?? new SpawnProcessRunner();
    this.processRunner = processRunner;
    this.runtime = options.runtime;
    this.executionProfiles = options.executionProfiles ?? emptyExecutionProfiles();
    const commandRunner =
      options.commandRunner ?? (options.processRunner ? processRunner : new PtyProcessRunner());
    const git = createGitClient(processRunner);
    this.worktrees = new WorktreeManager(options.config, git);
    this.runner = new SessionRunner({
      worktrees: this.worktrees,
      processRunner,
      commandRunner,
      ...(options.childEnvSource ? { childEnvSource: options.childEnvSource } : {}),
      executionProfiles: this.executionProfiles,
      onLog: (chunk) => void this.emitLog(chunk),
      now: this.now,
    });
  }
  async start(): Promise<void> {
    this.runtime ??= await probeGitReadiness(this.processRunner);
    if (this.runtime.gitReady) await this.worktrees.ensureAll();
    this.transport.onMessage((msg) => {
      void this.handleServerMessage(msg).catch((err: unknown) => {
        this.onLog?.(`server message failed: ${err instanceof Error ? err.message : String(err)}`);
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
      onRegistered: () => {
        // A reconnect registration carrying `draining: true` is itself a
        // durable acknowledgement. This covers a lost drain reply.
        if (this.drainRequested) this.confirmDrain();
      },
      abortAfterMs: this.reconnectAbortMs,
      timers: this.timers,
    });
    await this.register();
  }
  async applyInventory(next: DaemonConfig): Promise<void> {
    await applyDaemonInventory(this.config, next, this.worktrees, () => this.register());
  }
  async register(): Promise<void> {
    const runningAttempts = [...this.inflight.values()]
      .filter((session) => session.acknowledged && !session.controller.signal.aborted)
      .map((session) => ({ sessionId: session.sessionId, attemptId: session.attemptId }));
    await registerDaemon(
      this.config,
      this.transport,
      runningAttempts.map((attempt) => attempt.sessionId),
      this.drainRequested || this.draining,
      this.daemonIdentity,
      this.runtime,
      runningAttempts,
      this.executionProfiles,
    );
  }
  async keepalive(): Promise<void> {
    await this.outbound.send({
      type: "host:keepalive",
      hostId: this.config.hostId,
      at: this.now(),
    });
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
      this.onLog?.(
        `drain notification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    return this.draining || this.isDrainingExternal?.() === true;
  }
  inflightCount(): number {
    return this.inflight.size;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.inflight.values()].map((entry) => entry.work));
  }

  stop(): void {
    if (this.drainRetry) this.timers.clearTimeout(this.drainRetry);
    if (this.drainDeadline) this.timers.clearTimeout(this.drainDeadline);
    this.drainDeadline = undefined;
    this.connectionEvents?.stop();
    this.transport.close();
  }

  private async handleServerMessage(msg: HostWireMessage): Promise<void> {
    switch (msg.type) {
      case "host:drain":
        this.confirmDrain();
        return;
      case "host:draining":
        if (msg.hostId === this.config.hostId) this.confirmDrain();
        return;
      case "session:cancel":
        this.handleCancel(msg);
        return;
      case "session:acknowledged":
        this.handleAcknowledged(msg);
        return;
      case "session:assign":
        await this.handleAssign(msg);
        return;
      default:
        return;
    }
  }

  private abortSupersededAttempts(sessionId: string, attemptId: string): void {
    for (const entry of this.inflight.values()) {
      if (entry.sessionId !== sessionId || entry.attemptId === attemptId) continue;
      this.onLog?.(`superseded attempt ${entry.attemptId} aborted for ${sessionId}`);
      entry.controller.abort();
    }
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

  private async handleAssign(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
  ): Promise<void> {
    if (this.isDraining()) {
      this.onLog?.(`draining: refused assign ${msg.sessionId}`);
      return;
    }
    if (!this.runtime?.gitReady) {
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
    const live = [...this.inflight.values()].filter((entry) => !entry.controller.signal.aborted);
    if (live.length >= this.executionProfiles.maxConcurrentAssignments) {
      this.onLog?.(`session capacity reached: refused assign ${msg.sessionId}`);
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
    const work = this.runAssign(msg, controller.signal);
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
          this.onLog?.(
            `drain notification retry failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => this.scheduleDrainRetry());
    }, this.drainRetryMs);
  }

  private async runAssign(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
    signal: AbortSignal,
  ): Promise<void> {
    // Scheduled assignments deliberately use the repository's main checkout;
    // ordinary assignments must name an inventoried worktree.
    if ((msg.worktreeId === null) !== (msg.sessionType === "scheduled")) {
      throw new Error(
        msg.worktreeId === null
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
    if (!(await this.waitForAcknowledgement(msg.sessionId, msg.attemptId, signal))) return;
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
    });

    if (result.logs.length > 0) {
      this.nextLogSeq.set(msg.sessionId, result.logs.at(-1)!.seq + 1);
    }
    await this.outbound.flush();
    await this.outbound.send({
      type: "session:status",
      sessionId: msg.sessionId,
      worktreeId: msg.worktreeId,
      attemptId: msg.attemptId,
      status: result.status,
      exitCode: result.exitCode,
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
      ...(result.cliResumeRef !== undefined ? { cliResumeRef: result.cliResumeRef } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
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
