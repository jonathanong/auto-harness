import type {
  AgentToServerMessage,
  AgentWireMessage,
  SessionAssign,
  SessionLogChunk,
} from "@auto-harness/shared";

import type { AgentConfig } from "./config.js";
import type { ProcessRunner } from "./executor.js";
import { SpawnProcessRunner } from "./executor.js";
import { createGitClient } from "./git.js";
import type { SessionRunResult } from "./session-runner.js";
import { SessionRunner } from "./session-runner.js";
import { WorktreeManager } from "./worktree-manager.js";

export type AgentTransport = {
  send(msg: AgentToServerMessage): Promise<void>;
  /** Register a handler for server→agent messages. */
  onMessage(handler: (msg: AgentWireMessage) => void): void;
  close(): void;
};

export type AgentLoopOptions = {
  config: AgentConfig;
  transport: AgentTransport;
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
export class AgentLoop {
  private readonly runner: SessionRunner;
  private readonly worktrees: WorktreeManager;
  private readonly inflight = new Map<string, Promise<void>>();
  private draining = false;
  private readonly isDrainingExternal: (() => boolean) | undefined;
  private readonly onLog: ((line: string) => void) | undefined;
  private readonly now: () => string;
  private readonly config: AgentConfig;
  private readonly transport: AgentTransport;

  constructor(options: AgentLoopOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.isDrainingExternal = options.isDraining ?? undefined;
    this.onLog = options.onLog ?? undefined;
    this.now = options.now ?? (() => new Date().toISOString());
    const processRunner = options.processRunner ?? new SpawnProcessRunner();
    const git = createGitClient(processRunner);
    this.worktrees = new WorktreeManager(options.config, git);
    this.runner = new SessionRunner({
      config: options.config,
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
    await this.transport.send({
      type: "agent:register",
      agentId: this.config.agentId,
      worktrees: this.config.repositories.flatMap((r) =>
        r.worktrees.map((w) => ({
          id: w.id,
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
      type: "agent:keepalive",
      agentId: this.config.agentId,
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

  private async handleServerMessage(msg: AgentWireMessage): Promise<void> {
    if (msg.type === "agent:drain") {
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
    msg: Extract<AgentWireMessage, { type: "session:assign" }>,
  ): Promise<void> {
    await this.transport.send({ type: "session:ack", sessionId: msg.sessionId });

    const assign: SessionAssign = {
      sessionId: msg.sessionId,
      repositoryId: msg.repositoryId,
      prompt: msg.prompt,
      commandProfile: msg.commandProfile,
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

/**
 * In-process transport binding an agent to a ControlPlane-like message handler.
 * Local parity for API Gateway WebSocket (no network required).
 */
export function createLoopbackTransport(opts: {
  sendToServer: (msg: AgentToServerMessage) => void | Promise<void>;
}): AgentTransport & { deliver(msg: AgentWireMessage): void } {
  let handler: ((msg: AgentWireMessage) => void) | null = null;
  return {
    async send(msg) {
      await opts.sendToServer(msg);
    },
    onMessage(h) {
      handler = h;
    },
    close() {
      handler = null;
    },
    deliver(msg) {
      handler?.(msg);
    },
  };
}
