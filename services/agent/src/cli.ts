import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SessionAssign } from "@auto-harness/shared";

import type { AgentConfig } from "./config.js";
import { loadAgentConfig } from "./config.js";
import { ensureAgentReady, runAssignedSession } from "./runtime.js";
import type { SessionRunResult } from "./session-runner.js";

export function printUsage(log: (msg: string) => void = console.log): void {
  log(`Usage:
  auto-harness-agent status [--config path]
  auto-harness-agent run-session --file session.json [--config path]
`);
}

export type RunSessionDeps = {
  loadConfig: (opts: { configPath?: string; env?: NodeJS.ProcessEnv }) => AgentConfig;
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

function getConfigPath(args: string[]): string | undefined {
  const configIdx = args.indexOf("--config");
  if (configIdx < 0) {
    return undefined;
  }
  return args[configIdx + 1];
}

/**
 * Normalize argv after the node/tsx entry. pnpm may forward a literal `--`
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

  const configPath = getConfigPath(args);

  if (command === "status") {
    const config = deps.loadConfig({
      ...(configPath !== undefined ? { configPath } : {}),
      env,
    });
    deps.log(
      JSON.stringify(
        {
          agentId: config.agentId,
          repositories: config.repositories.map((r) => ({
            id: r.id,
            path: r.path,
            worktrees: r.worktrees.map((w) => ({
              id: w.id,
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
    const config = deps.loadConfig({
      ...(configPath !== undefined ? { configPath } : {}),
      env,
    });
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
    deps.error(
      "start (WebSocket daemon) is not implemented until Phase 3; use run-session for local execution",
    );
    return 1;
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
