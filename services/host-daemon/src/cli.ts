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
import { ensureDaemonReady, runAssignedSession } from "./runtime.ts";
import type { SessionRunResult } from "./session-runner.ts";

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

export function printUsage(log: (msg: string) => void = console.log): void {
  log(`Usage:
  auto-harness-host-daemon status
  auto-harness-host-daemon run-session --file session.json
  auto-harness-host-daemon start [--ws ws://host/ws]

Identity (env; local defaults shown):
  HARNESS_HOST_ID   default local-1
  HARNESS_API_URL    default http://127.0.0.1:7420  (alias: HARNESS_API_HTTP)
                      On a deployed control plane this is the CloudFront WebUrl
                      from the deploy output (e.g. https://d111...cloudfront.net) —
                      never a raw API Gateway *.execute-api.*.amazonaws.com URL.
  HARNESS_API_KEY    service account token (when auth enabled)
  HARNESS_CHILD_ENV_ALLOWLIST  optional comma-separated child-process variables (non-HARNESS_)

--ws overrides only the WebSocket target (REST still resolves from HARNESS_API_URL). It
accepts a raw API Gateway endpoint directly — a deploy-day escape hatch if the CloudFront
WebSocket path misbehaves — which HARNESS_API_URL does not.

Host inventory (repos, worktrees) is configured via
API/UI: PUT /api/v1/hosts/:hostId/inventory — not a local config file.
`);
}

export type RunSessionDeps = {
  loadConfig: (opts: {
    env?: NodeJS.ProcessEnv;
    inline?: unknown;
  }) => Promise<DaemonConfig> | DaemonConfig;
  ensureReady: (config: DaemonConfig) => Promise<void>;
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

  if (command === "status") {
    const config = await deps.loadConfig({ env });
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
    const config = await deps.loadConfig({ env });
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
    const config = await deps.loadConfig({ env });
    const wsIdx = args.indexOf("--ws");
    const wsUrl = wsIdx >= 0 ? args[wsIdx + 1] : undefined;
    try {
      const { loadHostIdentity } = await import("./config.ts");
      const { startDaemon } = await import("./start-daemon.ts");
      await deps.ensureReady(config);
      const { stop } = await startDaemon({
        config,
        identity: loadHostIdentity(env),
        ...(wsUrl !== undefined ? { wsUrl } : {}),
        log: deps.log,
        error: deps.error,
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
            timeoutMs: shutdownTimeoutMs(env),
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
