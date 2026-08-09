import type { HostWireMessage, SessionLogChunk } from "@auto-harness/shared";
import type { DaemonTransport } from "./daemon-transport.ts";
import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";
import { OutboundQueue } from "./outbound-queue.ts";
import { sessionAssignFromWire } from "./session-assign.ts";
import type { SessionRunResult } from "./session-runner.ts";
import { SessionRunner } from "./session-runner.ts";
import { WorktreeManager } from "./worktree-manager.ts";
export type { DaemonTransport } from "./daemon-transport.ts";
export type DaemonLoopOptions = {
  config: DaemonConfig;
  transport: DaemonTransport;
  processRunner?: ProcessRunner;
  /** When true, refuse new assigns (drain / auto-update). */
  isDraining?: () => boolean;
  onLog?: (line: string) => void;
  now?: () => string;
};
type InflightSession = {
  controller: AbortController;
  work: Promise<void>;
};
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
  constructor(options: DaemonLoopOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.isDrainingExternal = options.isDraining ?? undefined;
    this.onLog = options.onLog ?? undefined;
    this.now = options.now ?? (() => new Date().toISOString());
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
    await this.register();
  }
  async applyInventory(next: DaemonConfig): Promise<void> {
    this.config.repositories = next.repositories;
    this.config.commandProfiles = next.commandProfiles;
    if (next.logLevel) {
      this.config.logLevel = next.logLevel;
    }
    await this.worktrees.ensureAll();
    await this.register();
  }

  async register(): Promise<void> {
    await this.outbound.send({
      type: "host:register",
      hostId: this.config.hostId,
      worktrees: this.config.repositories.flatMap((r) =>
        r.worktrees.map((w) => ({
          id: w.id,
          name: w.name,
          repositoryId: r.id,
          path: w.path,
          labels: w.labels,
        })),
      ),
      commandProfiles: Object.keys(this.config.commandProfiles),
    });
  }

  async keepalive(): Promise<void> {
    await this.outbound.send({
      type: "host:keepalive",
      hostId: this.config.hostId,
      at: this.now(),
    });
  }

  /** Phase 5 drain: finish inflight, accept no new assigns. Does not kill CLIs. */
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

    const controller = new AbortController();
    const work = this.runAssign(msg, controller.signal);
    this.inflight.set(msg.sessionId, { controller, work });
    try {
      await work;
    } finally {
      this.inflight.delete(msg.sessionId);
    }
  }

  private async runAssign(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.outbound.send({ type: "session:ack", sessionId: msg.sessionId });

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
    this.onLog?.(`[${chunk.stream}#${chunk.seq}] ${chunk.content}`);
    await this.outbound
      .send({
        type: "session:log",
        sessionId: chunk.sessionId,
        stream: chunk.stream,
        content: chunk.content,
        timestamp: chunk.timestamp,
        seq: chunk.seq,
      })
      .catch((err: unknown) => {
        this.onLog?.(`log delivery failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  }
}

export { createLoopbackTransport } from "./loopback-transport.ts";
