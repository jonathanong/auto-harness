/* eslint-disable max-lines */
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
import { sessionAssignFromWire } from "./session-assign.ts";
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
  private readonly isDrainingExternal: (() => boolean) | undefined;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly now: () => string;
  private readonly config: DaemonConfig;
  private readonly transport: DaemonTransport;
  private readonly outbound: OutboundQueue;
  private readonly reconnectAbortMs: number;
  private readonly ackConfirmationMs: number;
  private readonly timers: Pick<typeof globalThis, "setTimeout" | "clearTimeout">;
  private connectionEvents: { stop: () => void } | undefined;
  constructor(options: DaemonLoopOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.isDrainingExternal = options.isDraining ?? undefined;
    this.onLog = options.onLog ?? undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    this.reconnectAbortMs = options.reconnectAbortMs ?? 60_000;
    this.ackConfirmationMs = options.ackConfirmationMs ?? this.reconnectAbortMs;
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
    );
  }
  async keepalive(): Promise<void> {
    await this.outbound.send({
      type: "host:keepalive",
      hostId: this.config.hostId,
      at: this.now(),
    });
  }
  beginDrain(): void {
    this.draining = true;
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
    this.connectionEvents?.stop();
    this.transport.close();
  }

  private async handleServerMessage(msg: HostWireMessage): Promise<void> {
    if (msg.type === "host:drain") {
      this.beginDrain();
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

  private async runAssign(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.outbound.send({ type: "session:ack", sessionId: msg.sessionId }, { signal });
    if (!(await this.waitForAcknowledgement(msg.sessionId, signal))) return;

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
      status: result.status,
      exitCode: result.exitCode,
      ...(result.errorCode !== undefined ? { errorCode: result.errorCode } : {}),
      ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
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
