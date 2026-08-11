/* eslint-disable max-lines -- ordered daemon lifecycle belongs in this single loop. */
import type { HostWireMessage, SessionLogChunk } from "@auto-harness/shared";
import type { DaemonTransport } from "./daemon-transport-types.ts";
import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";
import { configureConnectionEvents } from "./daemon-connection-events.ts";
import { applyDaemonInventory, registerDaemon } from "./daemon-registration.ts";
import { sendDaemonLog } from "./daemon-log-sender.ts";
import { OutboundQueue } from "./outbound-queue.ts";
import { resolvedRouteMetadata, sessionAssignFromWire } from "./session-assign.ts";
import type { SessionRunResult } from "./session-runner.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";
export type { DaemonTransport } from "./daemon-transport-types.ts";
export type DaemonLoopOptions = {
  config: DaemonConfig;
  transport: DaemonTransport;
  processRunner?: ProcessRunner;
  isDraining?: () => boolean;
  onLog?: (line: string) => void;
  now?: () => string;
  reconnectAbortMs?: number;
  /** Maximum wait for peer confirmation that `session:ack` committed. */
  ackConfirmationMs?: number;
  /** Retry an unacknowledged durable drain notification at this interval. */
  drainRetryMs?: number;
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
};
type InflightSession = {
  controller: AbortController;
  work: Promise<void>;
  /** Set only by a server `session:acknowledged` wire message. */
  acknowledged: boolean;
  resolveAcknowledgement?: () => void;
};
const MAX_INFLIGHT_SESSIONS = 64;
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
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private connectionEvents: { stop: () => void } | undefined;
  constructor(options: DaemonLoopOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.isDrainingExternal = options.isDraining ?? undefined;
    this.onLog = options.onLog ?? undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    this.reconnectAbortMs = options.reconnectAbortMs ?? 75_000;
    this.ackConfirmationMs = options.ackConfirmationMs ?? this.reconnectAbortMs;
    this.drainRetryMs = options.drainRetryMs ?? 1_000;
    this.timers = options.timers ?? globalThis;
    this.outbound = new OutboundQueue(this.transport, (line) => this.onLog?.(line));
    const processRunner = options.processRunner ?? new SpawnProcessRunner();
    const git = createGitClient(processRunner);
    this.worktrees = new WorktreeManager(options.config, git);
    this.runner = new SessionRunner({
      worktrees: this.worktrees,
      processRunner,
      onLog: (chunk) => void this.emitLog(chunk),
      now: this.now,
    });
  }
  async start(): Promise<void> {
    await this.worktrees.ensureAll();
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
    await registerDaemon(
      this.config,
      this.transport,
      [...this.inflight].flatMap(([sessionId, session]) =>
        session.acknowledged ? [sessionId] : [],
      ),
      this.drainRequested || this.draining,
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
      this.scheduleDrainRetry();
    } catch (error) {
      // Keep drainRequested set: the next registration advertises the same
      // intent, but surface the failed notification so shutdown cannot exit
      // while the control plane may still schedule this host.
      this.drainConfirmation = undefined;
      this.resolveDrainConfirmation = undefined;
      this.scheduleDrainRetry();
      throw error;
    }
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
    this.connectionEvents?.stop();
    this.transport.close();
  }

  private async handleServerMessage(msg: HostWireMessage): Promise<void> {
    if (msg.type === "host:drain") {
      this.confirmDrain();
      return;
    }
    if (msg.type === "host:draining" && msg.hostId === this.config.hostId) {
      this.confirmDrain();
      return;
    }
    if (msg.type === "session:cancel") {
      const current = this.inflight.get(msg.sessionId);
      this.onLog?.(`cancel requested for ${msg.sessionId}`);
      if (current) {
        current.controller.abort();
      }
      return;
    }
    if (msg.type === "session:acknowledged") {
      const current = this.inflight.get(msg.sessionId);
      // Duplicate and late confirmations are harmless. The peer's durable
      // confirmation—not the outgoing write callback—permits execution.
      if (!current || current.acknowledged || current.controller.signal.aborted) return;
      current.acknowledged = true;
      const resolve = current.resolveAcknowledgement;
      current.resolveAcknowledgement = undefined;
      resolve?.();
      return;
    }
    if (msg.type !== "session:assign") {
      return;
    }
    if (this.isDraining()) {
      this.onLog?.(`draining: refused assign ${msg.sessionId}`);
      return;
    }

    if (this.inflight.has(msg.sessionId)) {
      this.onLog?.(`duplicate assign ignored for ${msg.sessionId}`);
      return;
    }

    if (this.inflight.size >= MAX_INFLIGHT_SESSIONS) {
      this.onLog?.(`session capacity reached: refused assign ${msg.sessionId}`);
      return;
    }

    const controller = new AbortController();
    // Install the slot before the first await so an immediate peer reply is
    // tied to this exact assignment.
    const entry: InflightSession = {
      controller,
      work: Promise.resolve(),
      acknowledged: false,
    };
    this.inflight.set(msg.sessionId, entry);
    const work = this.runAssign(msg, controller.signal);
    entry.work = work;
    try {
      await work;
    } finally {
      if (this.inflight.get(msg.sessionId) === entry) this.inflight.delete(msg.sessionId);
    }
  }

  private confirmDrain(): void {
    this.draining = true;
    this.drainRequested = true;
    if (this.drainRetry) this.timers.clearTimeout(this.drainRetry);
    this.drainRetry = undefined;
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
    if (!(await this.waitForAcknowledgement(msg.sessionId, signal))) return;
    const route = resolvedRouteMetadata(msg);
    if (route.targetIndex !== undefined || route.commandId || route.providerAccountId) {
      this.onLog?.(
        `resolved route for ${msg.sessionId}: target=${route.targetIndex ?? "?"}` +
          `${route.commandId ? ` command=${route.commandId}` : ""}` +
          `${route.providerAccountId ? ` providerAccount=${route.providerAccountId}` : ""}`,
      );
    }

    const assign = sessionAssignFromWire(msg);

    let result: SessionRunResult;
    try {
      result = await this.runner.run(assign, {
        signal,
        initialLogSeq: this.nextLogSeq.get(msg.sessionId) ?? 0,
      });
    } catch (err) {
      result = {
        status: "failed",
        exitCode: null,
        errorCode: "setup_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        logs: [],
      };
    }

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
    });
  }

  private async emitLog(chunk: SessionLogChunk): Promise<void> {
    await sendDaemonLog(this.outbound, this.onLog, chunk);
  }

  private async waitForAcknowledgement(sessionId: string, signal: AbortSignal): Promise<boolean> {
    const inflight = this.inflight.get(sessionId);
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
