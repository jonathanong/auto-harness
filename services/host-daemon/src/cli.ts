import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { installCrashLogging, onShutdownSignal, type SessionAssign } from "@auto-harness/shared";

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

export function printUsage(log: (msg: string) => void = console.log): void {
  log(`Usage:
  auto-harness-host-daemon status
  auto-harness-host-daemon run-session --file session.json
  auto-harness-host-daemon start [--ws ws://host/ws]

Identity (env; local defaults shown):
  HARNESS_HOST_ID   default local-1
  HARNESS_API_URL    default http://127.0.0.1:7420  (alias: HARNESS_API_HTTP)
  HARNESS_API_KEY    service account token (when auth enabled)
  HARNESS_CHILD_ENV_ALLOWLIST  optional comma-separated child-process variables (non-HARNESS_)

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
 * when invoked as `pnpm local:agent -- status` — strip it.
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
            logger: (message, err) =>
              deps.error(
                err === undefined
                  ? message
                  : `${message}: ${err instanceof Error ? err.message : String(err)}`,
              ),
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

if (process.argv[1]?.endsWith("cli.ts") || process.argv[1]?.endsWith("cli.js")) {
  installCrashLogging();
  void main().then((code) => {
    process.exitCode = code;
  });
}
