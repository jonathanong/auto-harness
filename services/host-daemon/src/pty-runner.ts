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
import { resolveTrustedExecutable } from "./resolve-executable.ts";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;

export type PtySpawn = (file: string, args: string[] | string, options: IPtyForkOptions) => IPty;

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

function escapeWindowsBatchArgument(value: string): string {
  if (/\r|\n/.test(value)) {
    throw new Error(
      "Cannot launch Windows batch command: CR/LF characters are not supported in arguments",
    );
  }
  if (value.length === 0) return '""';

  // Adapted from @npmcli/promise-spawn's ISC-licensed escape.cmd helper.
  // First apply the Win32 argv quote/backslash convention, then caret-escape
  // CMD metacharacters twice because a .cmd/.bat shim adds a second CMD parse.
  let escaped = value;
  if (/[ \t\n\v"]/.test(value)) {
    escaped = '"';
    for (let index = 0; index <= value.length; index += 1) {
      let slashCount = 0;
      while (value[index] === "\\") {
        index += 1;
        slashCount += 1;
      }
      if (index === value.length) {
        escaped += "\\".repeat(slashCount * 2);
        break;
      }
      if (value[index] === '"') {
        escaped += "\\".repeat(slashCount * 2 + 1);
      } else {
        escaped += "\\".repeat(slashCount);
      }
      escaped += value[index];
    }
    escaped += '"';
  }

  escaped = escaped.replace(/[ !%^&()<>|"]/g, "^$&");
  return escaped.replace(/[ !%^&()<>|"]/g, "^$&");
}

function ptyInvocation(
  resolvedCommand: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): [file: string, args: string[] | string] {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(resolvedCommand)) {
    return [resolvedCommand, args];
  }
  const commandLine = [resolvedCommand, ...args].map(escapeWindowsBatchArgument).join(" ");
  const commandInterpreter = resolveTrustedExecutable("cmd.exe", env, platform);
  return [commandInterpreter, `/d /s /c ${commandLine}`];
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

    // Resolved to an absolute path via resolveTrustedExecutable, searching
    // only `env`'s PATH — never `options.cwd` — for the same reason as
    // runGit/installWorkspaceDependencies: options.cwd is always the
    // untrusted session worktree, and Windows' child_process.spawn (libuv
    // search_path()) checks cwd before PATH for a bare command name.
    const env = options.env ?? createChildEnv();
    const resolvedCommand = resolveTrustedExecutable(command, env, this.platform);
    const [spawnCommand, spawnArgs] = ptyInvocation(resolvedCommand, args, env, this.platform);

    let terminal: IPty;
    try {
      terminal = this.spawn(spawnCommand, spawnArgs, {
        cols: DEFAULT_COLUMNS,
        cwd: options.cwd,
        encoding: "utf8",
        env,
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
        setTimeout(() => {
          signalProcess("SIGKILL");
        }, options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS);
      };

      const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
      const onAbort = () => stop("cancel");
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const dataSubscription = terminal.onData((data) => emitPtyChunk(options, data));
      terminal.onExit((event) => {
        closed = true;
        clearTimeout(timer);
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
