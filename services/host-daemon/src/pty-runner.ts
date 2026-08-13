import { constants } from "node:os";
import { existsSync } from "node:fs";
import type { IPty, IPtyForkOptions } from "node-pty";
import { spawn as spawnPty } from "node-pty";

import { createChildEnv } from "./child-env.ts";
import {
  formatSpawnEnoent,
  MAX_OUTPUT_CHUNK_BYTES,
  truncateUtf8,
  type ProcessResult,
  type ProcessRunner,
  type RunProcessOptions,
} from "./executor.ts";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;

export type PtySpawn = (file: string, args: string[], options: IPtyForkOptions) => IPty;

export type PtyProcessRunnerDependencies = {
  kill?: typeof process.kill;
  platform?: NodeJS.Platform;
  spawn?: PtySpawn;
};

function signalName(signal: number | undefined): NodeJS.Signals | null {
  if (!signal) return null;
  const match = Object.entries(constants.signals).find(([, number]) => number === signal);
  return (match?.[0] as NodeJS.Signals | undefined) ?? null;
}

function emitPtyChunk(options: RunProcessOptions, value: string): void {
  const data = truncateUtf8(value, MAX_OUTPUT_CHUNK_BYTES);
  options.onChunk({ stream: "stdout", data });
  if (Buffer.byteLength(value, "utf8") > MAX_OUTPUT_CHUNK_BYTES) {
    options.onChunk({ stream: "stdout", data: "\n[output chunk truncated]\n" });
  }
}

/**
 * Assigned-command runner backed by one pseudoterminal. Setup, git, and hook
 * processes intentionally remain on {@link SpawnProcessRunner}.
 */
export class PtyProcessRunner implements ProcessRunner {
  readonly outputStreams = "merged" as const;
  private readonly kill: typeof process.kill;
  private readonly platform: NodeJS.Platform;
  private readonly spawn: PtySpawn;

  constructor(dependencies: PtyProcessRunnerDependencies = {}) {
    this.kill = dependencies.kill ?? process.kill.bind(process);
    this.platform = dependencies.platform ?? process.platform;
    this.spawn = dependencies.spawn ?? spawnPty;
  }

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    const [command, ...args] = options.argv;
    if (!command) throw new Error("argv must be non-empty");
    if (!existsSync(options.cwd)) throw new Error(formatSpawnEnoent(command, options.cwd));
    if (options.signal?.aborted) {
      return { exitCode: null, timedOut: false, cancelled: true, signal: null };
    }

    let terminal: IPty;
    try {
      terminal = this.spawn(command, args, {
        cols: DEFAULT_COLUMNS,
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env ?? createChildEnv(),
        name: "xterm-256color",
        rows: DEFAULT_ROWS,
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || /not found/i.test(String((error as Error).message))) {
        throw new Error(formatSpawnEnoent(command, options.cwd), { cause: error });
      }
      throw error;
    }

    return await new Promise<ProcessResult>((resolve) => {
      let timedOut = false;
      let cancelled = false;
      let closed = false;
      let stopping = false;
      let escalation: ReturnType<typeof setTimeout> | undefined;

      const signalProcess = (signal: NodeJS.Signals): void => {
        if (this.platform !== "win32") {
          try {
            this.kill(-terminal.pid, signal);
            return;
          } catch {
            // Fall through to node-pty's direct-child signal.
          }
        }
        try {
          terminal.kill(this.platform === "win32" ? undefined : signal);
        } catch {
          // A concurrent exit already reaped the terminal.
        }
      };

      const stop = (reason: "timeout" | "cancel"): void => {
        if (closed || stopping) return;
        stopping = true;
        timedOut = reason === "timeout";
        cancelled = reason === "cancel";
        signalProcess("SIGTERM");
        escalation = setTimeout(() => {
          signalProcess("SIGKILL");
          escalation = undefined;
        }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
      };

      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
      const onAbort = () => stop("cancel");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const dataSubscription = terminal.onData((data) => emitPtyChunk(options, data));
      terminal.onExit((event) => {
        closed = true;
        clearTimeout(timer);
        if (escalation && !stopping) clearTimeout(escalation);
        options.signal?.removeEventListener("abort", onAbort);
        dataSubscription.dispose();
        const signal = signalName(event.signal);
        resolve({
          exitCode: signal ? null : event.exitCode,
          timedOut,
          ...(cancelled ? { cancelled: true } : {}),
          signal,
        });
      });
    });
  }
}
