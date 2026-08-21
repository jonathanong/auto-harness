import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  installCrashLogging,
  onShutdownSignal,
  type LifecycleLogger,
  type SessionAssign,
} from "@auto-harness/shared";

import type { DaemonConfig } from "./config.ts";
import { loadDaemonConfig } from "./config.ts";
import { printUsage } from "./cli-usage.ts";
import { loadEnvFileIfPresent } from "./host-service-env.ts";
import { installHostService, uninstallHostService, type HostServiceOpts } from "./host-service.ts";
import { ensureDaemonReady, runAssignedSession } from "./runtime.ts";
import type { SessionRunResult } from "./session-runner.ts";

export { printUsage } from "./cli-usage.ts";

/**
 * Upper bound on graceful shutdown. In-flight CLIs are drained, not killed, so this is
 * generous — but finite, so a wedged daemon can still be restarted.
 */
function shutdownTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.HARNESS_SHUTDOWN_TIMEOUT_MS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10 * 60_000;
}

/**
 * Builds onShutdownSignal's logger from deps.error. A curried factory rather than an
 * inline arrow at the call site: the returned function is a stable, named reference that
 * a test can invoke directly, instead of a fresh closure per `runCli` call that only
 * onShutdownSignal itself would ever call.
 */
export function shutdownLoggerFor(error: (msg: string) => void): LifecycleLogger {
  return (message, err) => {
    error(
      err === undefined
        ? message
        : `${message}: ${err instanceof Error ? err.message : String(err)}`,
    );
  };
}

export type RunSessionDeps = {
  loadConfig: (opts: {
    env?: NodeJS.ProcessEnv;
    inline?: unknown;
  }) => Promise<DaemonConfig> | DaemonConfig;
  ensureReady: (
    config: DaemonConfig,
  ) => Promise<import("@auto-harness/shared").HostRuntimeReport | void>;
  runSession: (
    config: DaemonConfig,
    assign: SessionAssign,
    onLog: (line: string) => void,
  ) => Promise<SessionRunResult>;
  readFile: (path: string) => string;
  log: (msg: string) => void;
  error: (msg: string) => void;
  /** Passed straight through to onShutdownSignal; defaults to the real process there. */
  process?: Pick<NodeJS.Process, "on" | "off" | "exit">;
  installService: (opts: HostServiceOpts) => number;
  uninstallService: (opts: HostServiceOpts) => number;
};

export function createDefaultRunSessionDeps(): RunSessionDeps {
  return {
    loadConfig: loadDaemonConfig,
    readFile: (path) => readFileSync(path, "utf8"),
    log: (msg) => {
      console.log(msg);
    },
    error: (msg) => {
      console.error(msg);
    },
    ensureReady: (config) => ensureDaemonReady(config),
    runSession: (config, assign, onLog) => runAssignedSession(config, assign, onLog),
    installService: installHostService,
    uninstallService: uninstallHostService,
  };
}

/**
 * Normalize argv after the node entry. pnpm may forward a literal `--`
 * when invoked as `pnpm local:daemon -- status` — strip it.
 */
export function normalizeCliArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  if (args[0] === "--") {
    return args.slice(1);
  }
  return args;
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: RunSessionDeps = createDefaultRunSessionDeps(),
): Promise<number> {
  const args = normalizeCliArgs(argv);
  const command = args[0];
  if (!command || command === "help" || command === "--help") {
    printUsage(deps.log);
    return command ? 0 : 1;
  }

  let resolvedEnv = env;
  try {
    resolvedEnv = loadEnvFileIfPresent(env, deps.readFile);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.error(`Cannot read HARNESS_ENV_FILE: ${detail}`);
    return 1;
  }

  if (command === "install-service") {
    return deps.installService({ env: resolvedEnv, log: deps.log, error: deps.error });
  }
  if (command === "uninstall-service") {
    return deps.uninstallService({ env: resolvedEnv, log: deps.log, error: deps.error });
  }

  if (command === "status") {
    const config = await deps.loadConfig({ env: resolvedEnv });
    deps.log(
      JSON.stringify(
        {
          hostId: config.hostId,
          repositories: config.repositories.map((r) => ({
            id: r.id,
            path: r.path,
            worktrees: r.worktrees.map((w) => ({
              id: w.id,
              name: w.name,
              path: w.path,
              labels: w.labels,
            })),
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  if (command === "run-session") {
    const fileIdx = args.indexOf("--file");
    const file = fileIdx >= 0 ? args[fileIdx + 1] : undefined;
    if (!file) {
      deps.error("--file is required");
      return 1;
    }
    const config = await deps.loadConfig({ env: resolvedEnv });
    const assign = JSON.parse(deps.readFile(resolve(file))) as SessionAssign;
    await deps.ensureReady(config);
    const result = await deps.runSession(config, assign, deps.log);
    deps.log(
      JSON.stringify({
        status: result.status,
        exitCode: result.exitCode,
        errorCode: result.errorCode,
      }),
    );
    return result.status === "completed" ? 0 : 1;
  }

  if (command === "start") {
    const config = await deps.loadConfig({ env: resolvedEnv });
    const wsIdx = args.indexOf("--ws");
    const wsUrl = wsIdx >= 0 ? args[wsIdx + 1] : undefined;
    try {
      const { loadHostIdentity } = await import("./config.ts");
      const { startDaemon } = await import("./start-daemon.ts");
      const runtime = await deps.ensureReady(config);
      const { stop } = await startDaemon({
        config,
        identity: loadHostIdentity(resolvedEnv),
        ...(wsUrl !== undefined ? { wsUrl } : {}),
        log: deps.log,
        error: deps.error,
        ...(runtime ? { runtime } : {}),
      });
      // The previous handler ran stop() again on a second signal, had no catch — so a
      // rejecting stop() became an unhandled rejection during shutdown — and only set
      // process.exitCode, which does not end a process holding an open handle.
      await new Promise<void>((finished) => {
        onShutdownSignal(
          async () => {
            await stop();
            finished();
          },
          {
            timeoutMs: shutdownTimeoutMs(resolvedEnv),
            ...(deps.process ? { process: deps.process } : {}),
            logger: shutdownLoggerFor(deps.error),
          },
        );
      });
      return 0;
    } catch (err) {
      deps.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  deps.error(`Unknown command: ${command}`);
  printUsage(deps.log);
  return 1;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  return runCli(argv);
}

/** True only when this file is the literal entrypoint (`node cli.ts`/`cli.js`), not when a test imports it. */
export function isDirectInvocation(argv1: string | undefined): boolean {
  // Compare the exact basename, not a suffix: endsWith("cli.ts") also matches an
  // unrelated file like mycli.ts, which would run main() on mere import.
  const filename = argv1 === undefined ? undefined : basename(argv1);
  return filename === "cli.ts" || filename === "cli.js";
}

export function setExitCode(code: number): void {
  process.exitCode = code;
}

if (isDirectInvocation(process.argv[1])) {
  installCrashLogging();
  void main().then(setExitCode);
}
