import type { HostWireMessage, SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { DaemonTransport } from "./daemon-transport.ts";
import type { DaemonConfig } from "./config.ts";
import type { ProcessRunner } from "./executor.ts";
import { SpawnProcessRunner } from "./executor.ts";
import { createGitClient } from "./git.ts";
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

/**
 * Phase 3 agent loop: register → receive assign → ack → run profile → status/logs.
 * Does not kill in-flight CLIs on drain (Phase 5); only refuses new work.
 */
export class DaemonLoop {
  private readonly runner: SessionRunner;
  private readonly worktrees: WorktreeManager;
  private readonly inflight = new Map<string, Promise<void>>();
  private draining = false;
  private readonly isDrainingExternal: (() => boolean) | undefined;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly now: () => string;
  private readonly config: DaemonConfig;
  private readonly transport: DaemonTransport;

  constructor(options: DaemonLoopOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.isDrainingExternal = options.isDraining ?? undefined;
    this.onLog = options.onLog ?? undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    const processRunner = options.processRunner ?? new SpawnProcessRunner();
    const git = createGitClient(processRunner);
    this.worktrees = new WorktreeManager(options.config, git);
    this.runner = new SessionRunner({
      worktrees: this.worktrees,
      processRunner,
      onLog: (chunk) => {
        void this.emitLog(chunk);
      },
      now: this.now,
    });
  }

  async start(): Promise<void> {
    await this.worktrees.ensureAll();
    this.transport.onMessage((msg) => {
      void this.handleServerMessage(msg);
    });
    await this.register();
  }

  /**
   * Hot-apply host inventory from the control plane (repos/profiles added via UI).
   * Mutates the shared config object used by the session runner / worktree manager.
   */
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
    await this.transport.send({
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
    await this.transport.send({
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
    if (this.draining) {
      return true;
    }
    if (this.isDrainingExternal) {
      return this.isDrainingExternal();
    }
    return false;
  }

  inflightCount(): number {
    return this.inflight.size;
  }

  async waitForIdle(): Promise<void> {
    await Promise.all(this.inflight.values());
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
      // Soft cancel: runner has no mid-flight cancel API yet; log only.
      this.onLog?.(`cancel requested for ${msg.sessionId}`);
      return;
    }
    if (msg.type !== "session:assign") {
      return;
    }
    if (this.isDraining()) {
      this.onLog?.(`draining: refused assign ${msg.sessionId}`);
      return;
    }

    const work = this.runAssign(msg);
    this.inflight.set(msg.sessionId, work);
    try {
      await work;
    } finally {
      this.inflight.delete(msg.sessionId);
    }
  }

  private async runAssign(
    msg: Extract<HostWireMessage, { type: "session:assign" }>,
  ): Promise<void> {
    await this.transport.send({ type: "session:ack", sessionId: msg.sessionId });

    const assign: SessionAssign = {
      sessionId: msg.sessionId,
      repositoryId: msg.repositoryId,
      prompt: msg.prompt,
      resolvedArgv: msg.resolvedArgv,
      timeout: msg.timeout,
      worktreeId: msg.worktreeId,
      ...(msg.ref !== undefined ? { ref: msg.ref } : {}),
      ...(msg.setupScript !== undefined ? { setupScript: msg.setupScript } : {}),
      ...(msg.resume !== undefined ? { resume: msg.resume } : {}),
      ...(msg.resumedFromSessionId !== undefined
        ? { resumedFromSessionId: msg.resumedFromSessionId }
        : {}),
      ...(msg.cliResumeRef !== undefined ? { cliResumeRef: msg.cliResumeRef } : {}),
      ...(msg.metadata !== undefined ? { metadata: msg.metadata } : {}),
    };

    let result: SessionRunResult;
    try {
      result = await this.runner.run(assign);
    } catch (err) {
      result = {
        status: "failed",
        exitCode: null,
        errorCode: "setup_failed",
        errorMessage: err instanceof Error ? err.message : String(err),
        logs: [],
      };
    }

    await this.transport.send({
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
    await this.transport.send({
      type: "session:log",
      sessionId: chunk.sessionId,
      stream: chunk.stream,
      content: chunk.content,
      timestamp: chunk.timestamp,
      seq: chunk.seq,
    });
  }
}

export { createLoopbackTransport } from "./loopback-transport.ts";
