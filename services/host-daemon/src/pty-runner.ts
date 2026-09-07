import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { createChildEnv } from "./child-env.ts";
import {
  formatSpawnEnoent,
  MAX_OUTPUT_CHUNK_BYTES,
  OUTPUT_CHUNK_TRUNCATION_MARKER,
  truncateUtf8,
  type ProcessResult,
  type ProcessRunner,
  type RunProcessOptions,
} from "./executor.ts";
import { killGroupOrPid } from "./kill-group-or-pid.ts";
import { resolveAssignedExecutable } from "./resolve-executable.ts";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;

/**
 * Exit outcome from a {@link PtyHandle}. `signaled: true` means "killed by
 * some signal, unspecified" -- PtyProcessRunner.run() resolves the actual
 * signal name itself, from the last one it sent, not from the pty layer.
 */
type PtyExitEvent = { exitCode: number; signaled: boolean };

export type PtyHandle = {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: PtyExitEvent) => void): { dispose(): void };
};

type PtyForkOptions = {
  cols: number;
  cwd: string;
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  /** Pty terminal type. Ruspty has no `name` option; spawnRuspty injects
   * this as `TERM` for a host with no controlling tty (systemd/launchd),
   * since createChildEnv() only forwards an existing TERM. An explicit
   * `env.TERM` still wins. */
  name: string;
  rows: number;
};

export type PtySpawn = (
  file: string,
  args: string[],
  options: PtyForkOptions,
  kill: typeof process.kill,
) => PtyHandle | Promise<PtyHandle>;

export type PtyProcessRunnerDependencies = {
  kill?: typeof process.kill;
  platform?: NodeJS.Platform;
  spawn?: PtySpawn;
  /**
   * Skip this runner's own 32 KiB-per-read truncation and emit each PTY read whole.
   * Only a wrapper that re-applies the same byte cap on its own forwarding path
   * (e.g. {@link UsageCapturingProcessRunner}) may set this — an unwrapped runner
   * must keep truncating so a noisy process can't allocate unbounded memory.
   */
  emitUntruncated?: boolean;
};

function emitPtyChunk(options: RunProcessOptions, value: string, emitUntruncated: boolean): void {
  if (emitUntruncated) {
    options.onChunk({ stream: "stdout", data: value });
    return;
  }
  const data = truncateUtf8(value, MAX_OUTPUT_CHUNK_BYTES);
  options.onChunk({ stream: "stdout", data });
  if (Buffer.byteLength(value, "utf8") > MAX_OUTPUT_CHUNK_BYTES) {
    options.onChunk({ stream: "stdout", data: OUTPUT_CHUNK_TRUNCATION_MARKER });
  }
}

/**
 * Default {@link PtySpawn}, backed by `@replit/ruspty` (POSIX only -- see
 * {@link PtyProcessRunner.run}'s win32 guard). Imported dynamically so this
 * module stays loadable on win32, where no ruspty native binary exists.
 *
 * ruspty exposes no `.kill()`, so PtyProcessRunner signals via the exposed
 * `pid` instead. Its `onExit` is one constructor-supplied callback, not a
 * subscribable event; this adapter buffers it behind `onExit()`, safe since
 * `run()` always attaches its listener synchronously, before spawn()'s
 * result can exit.
 */
async function spawnRuspty(
  file: string,
  args: string[],
  options: PtyForkOptions,
  kill: typeof process.kill,
): Promise<PtyHandle> {
  const { Pty } = await import("@replit/ruspty");
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((event: PtyExitEvent) => void) | undefined;
  const decoder = new StringDecoder("utf8");

  const envs: Record<string, string> = { TERM: options.name };
  for (const [key, value] of Object.entries(options.env)) {
    if (value !== undefined) envs[key] = value;
  }

  const pty = new Pty({
    command: file,
    args,
    envs,
    dir: options.cwd,
    size: { cols: options.cols, rows: options.rows },
    onExit: (_error, code) => {
      exitListener?.({ exitCode: code, signaled: code === -1 });
    },
  });
  pty.read.on("data", (chunk: Buffer) => dataListener?.(decoder.write(chunk)));
  // `.pipe()` never forwards 'error' from the upstream socket to this
  // downstream SyntheticEOFDetector stage; unhandled, that would be an
  // unhandled 'error' on a Readable -- crashing the whole daemon, not just
  // this session. Report it as an abnormal exit instead. `signaled: false`:
  // we don't know a signal killed it, and guessing one mid-escalation would
  // actively mislead.
  //
  // Doesn't cover the upstream socket itself: the wrapper's own handleError
  // swallows EINTR/EAGAIN/EIO but re-throws any other errno synchronously,
  // before a listener added here (even on the aliased `pty.write`) can run.
  // Structural to the wrapper, not interceptable from outside; verified
  // empirically, not just by reading the source.
  //
  // This path also doesn't imply the child exited -- it's a pipe-stage
  // error, not the real wait() ruspty's own onExit waits for (see
  // wrapper.ts's handleClose). `.close()` only ends the JS-side stream, not
  // the child, so signal it directly with SIGKILL -- no SIGTERM-then-grace
  // ladder, since there's no stream left to observe a graceful shutdown on.
  pty.read.on("error", () => {
    killGroupOrPid(kill, pty.pid, "SIGKILL");
    exitListener?.({ exitCode: 1, signaled: false });
  });

  return {
    pid: pty.pid,
    onData(listener) {
      dataListener = listener;
      return { dispose: () => (dataListener = undefined) };
    },
    onExit(listener) {
      exitListener = listener;
      return { dispose: () => (exitListener = undefined) };
    },
  };
}

/**
 * Assigned-command runner backed by one pseudoterminal. Setup, git, and hook
 * processes intentionally remain on {@link SpawnProcessRunner}.
 *
 * POSIX only: ruspty ships no Windows build, so a session's command can't
 * run in a PTY there; {@link SpawnProcessRunner} still handles
 * git/setup/hooks on Windows.
 *
 * Truncates each read to `MAX_OUTPUT_CHUNK_BYTES`, like `SpawnProcessRunner`.
 * `dependencies.emitUntruncated` lifts that cap for a caller that re-applies
 * it itself (only `UsageCapturingProcessRunner`).
 */
export class PtyProcessRunner implements ProcessRunner {
  readonly outputStreams = "merged" as const;
  private readonly kill: typeof process.kill;
  private readonly platform: NodeJS.Platform;
  private readonly spawn: PtySpawn;
  private readonly emitUntruncated: boolean;

  constructor(dependencies: PtyProcessRunnerDependencies = {}) {
    this.kill = dependencies.kill ?? process.kill.bind(process);
    this.platform = dependencies.platform ?? process.platform;
    this.spawn = dependencies.spawn ?? spawnRuspty;
    this.emitUntruncated = dependencies.emitUntruncated ?? false;
  }

  async run(options: RunProcessOptions): Promise<ProcessResult> {
    if (this.platform === "win32") {
      throw new Error("PTY sessions are not supported on Windows");
    }
    const [command, ...args] = options.argv;
    if (!command) throw new Error("argv must be non-empty");
    if (!existsSync(options.cwd)) throw new Error(formatSpawnEnoent(command, options.cwd));
    if (options.signal?.aborted) {
      return { exitCode: null, timedOut: false, cancelled: true, signal: null };
    }

    // Bare commands are resolved through trusted PATH only. Explicit relative
    // commands are lexically resolved against the assigned checkout before
    // spawning; both forms become absolute so a spawned shell can't apply a
    // cwd-before-PATH executable search to an untrusted worktree.
    const env = options.env ?? createChildEnv();
    const resolvedCommand = resolveAssignedExecutable(command, options.cwd, env, this.platform);

    let terminal: PtyHandle | undefined;
    let timedOut = false;
    let cancelled = false;
    let closed = false;
    let stopping = false;
    let killTimerConsumedAsNoop = false;
    let lastSignalSent: NodeJS.Signals | null = null;

    const signalProcess = (signal: NodeJS.Signals): void => {
      // No-op until spawn resolves — stop() can run while spawn() is still
      // in flight (it's async — see spawnRuspty). The catch-up block right
      // after spawn resolves (below) retries whichever signal this dropped.
      if (!terminal) return;
      lastSignalSent = signal;
      killGroupOrPid(this.kill, terminal.pid, signal);
    };

    const armKillTimer = (): void => {
      setTimeout(() => {
        if (!terminal) {
          // Spawn still hasn't resolved by the end of the grace period; the
          // post-spawn catch-up below arms a fresh one once it does, so this
          // grace window is never silently lost.
          killTimerConsumedAsNoop = true;
          return;
        }
        signalProcess("SIGKILL");
      }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
    };

    const stop = (reason: "timeout" | "cancel"): void => {
      if (closed || stopping) return;
      stopping = true;
      timedOut = reason === "timeout";
      cancelled = reason === "cancel";
      signalProcess("SIGTERM");
      armKillTimer();
    };

    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("cancel");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      terminal = await this.spawn(
        resolvedCommand,
        args,
        {
          cols: DEFAULT_COLUMNS,
          cwd: options.cwd,
          encoding: "utf8",
          env,
          name: "xterm-256color",
          rows: DEFAULT_ROWS,
        },
        this.kill,
      );
    } catch (error) {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || /not found/i.test(String((error as Error).message))) {
        throw new Error(formatSpawnEnoent(command, options.cwd), { cause: error });
      }
      throw error;
    }

    // A stop() requested while spawn() was still in flight found no terminal
    // to signal yet. Retry the SIGTERM now that one exists, and re-arm the
    // SIGKILL timer only if the original one already elapsed as a no-op —
    // otherwise it's still pending and will fire for real.
    if (stopping) {
      signalProcess("SIGTERM");
      if (killTimerConsumedAsNoop) armKillTimer();
    }

    return await new Promise<ProcessResult>((resolve) => {
      const spawned = terminal;
      const dataSubscription = spawned.onData((data) =>
        emitPtyChunk(options, data, this.emitUntruncated),
      );
      spawned.onExit((event) => {
        closed = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        dataSubscription.dispose();
        const signal = event.signaled ? lastSignalSent : null;
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
