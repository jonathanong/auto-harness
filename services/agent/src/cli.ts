import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SessionAssign } from "@auto-harness/shared";

import type { AgentConfig } from "./config.ts";
import { loadAgentConfig } from "./config.ts";
import { ensureAgentReady, runAssignedSession } from "./runtime.ts";
import type { SessionRunResult } from "./session-runner.ts";

export function printUsage(log: (msg: string) => void = console.log): void {
  log(`Usage:
  auto-harness-agent status
  auto-harness-agent run-session --file session.json
  auto-harness-agent start [--ws ws://host/ws]

Identity (env; local defaults shown):
  HARNESS_AGENT_ID   default local-1
  HARNESS_API_URL    default http://127.0.0.1:7420  (alias: HARNESS_API_HTTP)
  HARNESS_API_KEY    service account token (when auth enabled)
  HARNESS_LOG_LEVEL  optional (debug|info|warn|error)

Host inventory (repos, worktrees, commandProfiles) is configured via
API/UI: PUT /api/v1/agents/:agentId/config — not a local config file.
`);
}

export type RunSessionDeps = {
  loadConfig: (opts: {
    env?: NodeJS.ProcessEnv;
    inline?: unknown;
  }) => Promise<AgentConfig> | AgentConfig;
  ensureReady: (config: AgentConfig) => Promise<void>;
  runSession: (
    config: AgentConfig,
    assign: SessionAssign,
    onLog: (line: string) => void,
  ) => Promise<SessionRunResult>;
  readFile: (path: string) => string;
  log: (msg: string) => void;
  error: (msg: string) => void;
};

export function createDefaultRunSessionDeps(): RunSessionDeps {
  return {
    loadConfig: loadAgentConfig,
    readFile: (path) => readFileSync(path, "utf8"),
    log: (msg) => {
      console.log(msg);
    },
    error: (msg) => {
      console.error(msg);
    },
    ensureReady: (config) => ensureAgentReady(config),
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
          agentId: config.agentId,
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
          commandProfiles: Object.keys(config.commandProfiles),
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
      const { loadAgentIdentity } = await import("./config.ts");
      const { startAgentDaemon } = await import("./start-daemon.ts");
      await deps.ensureReady(config);
      const { stop } = await startAgentDaemon({
        config,
        identity: loadAgentIdentity(env),
        ...(wsUrl !== undefined ? { wsUrl } : {}),
        log: deps.log,
        error: deps.error,
      });
      const shutdown = (): void => {
        void stop().then(() => {
          process.exitCode = 0;
        });
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      await new Promise<void>(() => {
        /* run until killed */
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
  void main().then((code) => {
    process.exitCode = code;
  });
}
