import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import { createChildEnv } from "./child-env.ts";
import { killWindowsProcessTree, type WindowsProcessTreeKill } from "./windows-process-tree.ts";
import type { SessionUsage } from "@auto-harness/shared";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
export const MAX_OUTPUT_CHUNK_BYTES = 32 * 1024;

export function truncateUtf8(data: string, maxBytes: number): string {
  if (Buffer.byteLength(data, "utf8") <= maxBytes) return data;
  let bytes = 0;
  let result = "";
  for (const char of data) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    result += char;
    bytes += size;
  }
  return result;
}

export type OutputChunk = {
  stream: "stdout" | "stderr";
  data: string;
};

export type RunProcessOptions = {
  argv: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Cancels the child (and its POSIX process group, or Windows process tree) promptly. */
  signal?: AbortSignal;
  /** Test-only/advanced override; production uses a five second grace period. */
  terminationGraceMs?: number;
  onChunk: (chunk: OutputChunk) => void;
};

export type ProcessResult = {
  exitCode: number | null;
  timedOut: boolean;
  cancelled?: boolean;
  signal: NodeJS.Signals | null;
  /** Supplied by a provider-aware CLI adapter; never inferred from output. */
  usage?: SessionUsage;
  /** Adapter-supplied vendor quota; never inferred from untrusted output. */
  usageLimit?: boolean;
  /** Exported environment captured after a trusted setup script succeeds. */
  environment?: NodeJS.ProcessEnv;
};

/**
 * Host process runner. Default uses child_process.spawn with shell: false.
 * Tests inject fakes; only this boundary may be mocked for CLI tools.
 */
export interface ProcessRunner {
  /** Set when stdout and stderr share one terminal byte stream. */
  readonly outputStreams?: "merged";
  run(options: RunProcessOptions): Promise<ProcessResult>;
}

/** Node often reports ENOENT for a missing cwd as well as a missing binary. */
export function formatSpawnEnoent(command: string, cwd: string): string {
  if (!existsSync(cwd)) {
    return (
      `Cannot run ${command}: working directory does not exist: ${cwd}. ` +
      `Remove stale host-inventory repos (agent Config / control plane) or create that path.`
    );
  }
  return `Cannot run ${command}: executable not found in PATH (ENOENT)`;
}

export type SpawnProcessRunnerDependencies = {
  platform?: NodeJS.Platform;
  /** Test-only override; production kills via `taskkill /T /F`. */
  killWindowsProcessTree?: WindowsProcessTreeKill;
};

export class SpawnProcessRunner implements ProcessRunner {
  private readonly platform: NodeJS.Platform;
  private readonly killWindowsProcessTree: WindowsProcessTreeKill;

  constructor(dependencies: SpawnProcessRunnerDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.killWindowsProcessTree = dependencies.killWindowsProcessTree ?? killWindowsProcessTree;
  }

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    if (options.argv.length === 0) {
      throw new Error("argv must be non-empty");
    }
    const [command, ...args] = options.argv;
    if (!command) {
      throw new Error("argv must be non-empty");
    }

    if (!existsSync(options.cwd)) {
      throw new Error(formatSpawnEnoent(command, options.cwd));
    }

    if (options.signal?.aborted) {
      return {
        exitCode: null,
        timedOut: false,
        cancelled: true,
        signal: null,
      };
    }

    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? createChildEnv(),
        shell: false,
        // A detached POSIX child starts a process group. This makes timeout and
        // cancellation kill helpers that a CLI may have spawned as well.
        detached: this.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      let timedOut = false;
      let cancelled = false;
      let closed = false;
      let stopping = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      // Node fires "exit" as soon as the direct child's process ends, but
      // delays "close" until its stdio streams also close -- which stalls
      // for as long as a backgrounded descendant (the node.exe a cmd.exe
      // launcher started, see #348) keeps holding the inherited pipes open.
      // `child.pid` is never updated after exit, so once the direct child
      // has exited, that number is a stale pid Windows may already have
      // recycled for an unrelated process; only `child.kill()` -- which
      // signals via the handle retained from spawn, not a PID re-lookup --
      // stays safe to call in that window.
      let rootExited = false;

      const signalProcess = (signal: NodeJS.Signals): void => {
        if (this.platform === "win32") {
          // Windows children never join a POSIX process group; reach
          // descendants (e.g. the node.exe a cmd.exe launcher started) via
          // taskkill instead of a plain child.kill(), which only signals the
          // direct child. Skip it once the root has already exited: taskkill
          // re-resolves the pid itself, so a stale/recycled pid there could
          // force-kill an unrelated process tree instead.
          if (child.pid !== undefined && !rootExited) {
            try {
              if (this.killWindowsProcessTree(child.pid)) return;
            } catch {
              // Fall through to direct child signal.
            }
          }
        } else {
          // Negative pid addresses the group created by detached:true. If
          // group signalling is unavailable, kill the direct child as the
          // safe fallback.
          try {
            process.kill(-child.pid!, signal);
            return;
          } catch {
            // Fall through to direct child signal.
          }
        }
        try {
          child.kill(signal);
        } catch {
          // A concurrent close already reaped it.
        }
      };

      const stop = (reason: "timeout" | "cancel"): void => {
        if (closed || stopping) return;
        stopping = true;
        timedOut = reason === "timeout";
        cancelled = reason === "cancel";
        signalProcess("SIGTERM");
        // taskkill /F is already maximally forceful, so there is no softer
        // first stage to escalate from on Windows -- and a delayed second
        // taskkill call is actively dangerous there: Windows recycles PIDs
        // aggressively, so by the time the grace period elapses the numeric
        // pid can belong to an unrelated process and its tree. POSIX still
        // escalates because a reaped pid is inert to `process.kill`/`child.kill`
        // (ESRCH), not silently redirected to a different process.
        if (this.platform === "win32") return;
        escalation = setTimeout(() => {
          // The direct child may close after SIGTERM while descendants in its
          // detached POSIX process group survive. Escalate the group anyway.
          signalProcess("SIGKILL");
          escalation = undefined;
        }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
      };

      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
      const onAbort = () => stop("cancel");
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const emitChunk = (stream: OutputChunk["stream"], buf: Buffer): void => {
        // Keep a malicious/noisy process from allocating unbounded memory in
        // either the agent or the control-plane log transport.
        // Buffer#toString may turn a truncated multi-byte character into U+FFFD,
        // which is larger than the original incomplete sequence. Bound the
        // encoded string too: the wire limit is measured in bytes, not chars.
        const data = truncateUtf8(
          buf.subarray(0, MAX_OUTPUT_CHUNK_BYTES).toString("utf8"),
          MAX_OUTPUT_CHUNK_BYTES,
        );
        options.onChunk({ stream, data });
        if (buf.length > MAX_OUTPUT_CHUNK_BYTES) {
          options.onChunk({ stream, data: "\n[output chunk truncated]\n" });
        }
      };

      child.stdout?.on("data", (buf: Buffer) => {
        emitChunk("stdout", buf);
      });
      child.stderr?.on("data", (buf: Buffer) => {
        emitChunk("stderr", buf);
      });

      child.on("exit", () => {
        rootExited = true;
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        if (escalation) clearTimeout(escalation);
        options.signal?.removeEventListener("abort", onAbort);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new Error(formatSpawnEnoent(command, options.cwd)));
          return;
        }
        reject(err);
      });

      child.on("close", (code, signal) => {
        closed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode: code,
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
          signal,
        });
      });
    });
  }
}
