/* eslint-disable max-lines -- CLI command dispatch and its bounded status report share one entrypoint. */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  installCrashLogging,
  MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH,
  MAX_RUNTIME_ENVIRONMENT_NAMES,
  onShutdownSignal,
  type LifecycleLogger,
  type SessionAssign,
} from "@auto-harness/shared";

import type { DaemonConfig, HostIdentity } from "./config.ts";
import { loadDaemonConfig, loadHostIdentity } from "./config.ts";
import { printUsage } from "./cli-usage.ts";
import { createChildEnv, parseChildEnvAllowlist } from "./child-env.ts";
import { loadEnvFileIfPresent } from "./host-service-env.ts";
import {
  getHostServiceStatus,
  installHostService,
  uninstallHostService,
  type HostServiceOpts,
  type HostServiceStatus,
} from "./host-service.ts";
import { fetchControlPlaneHostStatus, type ControlPlaneHostStatus } from "./host-status.ts";
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
    childEnvSource: NodeJS.ProcessEnv,
  ) => Promise<SessionRunResult>;
  readFile: (path: string) => string;
  log: (msg: string) => void;
  error: (msg: string) => void;
  /** Passed straight through to onShutdownSignal; defaults to the real process there. */
  process?: Pick<NodeJS.Process, "on" | "off" | "exit">;
  installService: (opts: HostServiceOpts) => number;
  uninstallService: (opts: HostServiceOpts) => number;
  statusService: (opts: HostServiceOpts) => HostServiceStatus;
  fetchHostStatus: (
    identity: HostIdentity,
    signal?: AbortSignal,
  ) => Promise<ControlPlaneHostStatus>;
};

const STATUS_TIMEOUT_MS = 10_000;

type DeadlineResult<T> =
  | { state: "fulfilled"; value: T }
  | { state: "rejected" }
  | { state: "timed_out" };

async function settleWithin<T>(
  operation: () => T | PromiseLike<T>,
  timeoutMs: number,
): Promise<DeadlineResult<T>> {
  if (timeoutMs <= 0) return { state: "timed_out" };
  return new Promise((finish) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      finish({ state: "timed_out" });
    }, timeoutMs);
    Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          finish({ state: "fulfilled", value });
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          finish({ state: "rejected" });
        },
      );
  });
}

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
    runSession: (config, assign, onLog, childEnvSource) =>
      runAssignedSession(config, assign, onLog, undefined, undefined, childEnvSource),
    installService: installHostService,
    uninstallService: uninstallHostService,
    statusService: getHostServiceStatus,
    fetchHostStatus: (identity, signal) => fetchControlPlaneHostStatus(identity, fetch, signal),
  };
}

function configuredInventory(config: DaemonConfig): Record<string, unknown> {
  return {
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
  };
}

function statusIdentity(config: DaemonConfig | undefined, env: NodeJS.ProcessEnv): HostIdentity {
  const envIdentity = loadHostIdentity(env);
  const identity: HostIdentity = {
    hostId: config?.hostId ?? envIdentity.hostId,
    apiUrl: config?.apiUrl ?? envIdentity.apiUrl,
  };
  const apiKey = config?.apiKey ?? envIdentity.apiKey;
  if (apiKey) identity.apiKey = apiKey;
  return identity;
}

function statusIsReady(service: HostServiceStatus, host: ControlPlaneHostStatus): boolean {
  return (
    service.state === "running" &&
    host.reachable &&
    host.online === true &&
    host.draining === false &&
    host.gitReady === true
  );
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

  let updateBootPrepared = false;
  if (command === "start") {
    try {
      const { prepareDaemonUpdateBoot } = await import("./start-daemon.ts");
      // Do this before every daemon preflight, including child-environment and
      // config validation, so a replacement that crashes during startup cannot
      // loop forever without consuming its rollback attempt.
      await prepareDaemonUpdateBoot({ env: resolvedEnv, log: deps.log, error: deps.error });
      updateBootPrepared = true;
    } catch (err) {
      deps.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
  }

  if (command === "install-service") {
    const apiUrlIndex = args.indexOf("--api-url");
    const apiUrl = apiUrlIndex >= 0 ? args[apiUrlIndex + 1] : undefined;
    if (apiUrlIndex >= 0 && (!apiUrl || apiUrl.startsWith("--"))) {
      deps.error("--api-url requires an HTTPS production control-plane URL");
      return 1;
    }
    return deps.installService({ env: resolvedEnv, log: deps.log, error: deps.error, apiUrl });
  }
  if (command === "uninstall-service") {
    return deps.uninstallService({ env: resolvedEnv, log: deps.log, error: deps.error });
  }

  if (command === "start" || command === "run-session") {
    const childEnvErrors = parseChildEnvAllowlist(resolvedEnv).errors;
    if (childEnvErrors.length > 0) {
      deps.error(childEnvErrors.join("; "));
      return 1;
    }
  }

  if (command === "status") {
    const configOnly = args.includes("--config-only");
    const deadline = Date.now() + STATUS_TIMEOUT_MS;
    const remaining = (): number => deadline - Date.now();
    let config: DaemonConfig | undefined;
    const configResult = await settleWithin(
      () => deps.loadConfig({ env: resolvedEnv }),
      remaining(),
    );
    if (configResult.state === "fulfilled") {
      config = configResult.value;
    } else {
      if (configOnly) {
        deps.error("Cannot load daemon configuration");
        return 1;
      }
    }
    if (configOnly) {
      if (!config) {
        deps.error("Cannot load daemon configuration");
        return 1;
      }
      deps.log(JSON.stringify(configuredInventory(config), null, 2));
      return 0;
    }

    const identity = statusIdentity(config, resolvedEnv);
    let service: HostServiceStatus;
    try {
      service = deps.statusService({
        env: resolvedEnv,
        log: () => undefined,
        error: () => undefined,
        timeoutMs: Math.max(1, remaining()),
      });
    } catch {
      service = { state: "unknown", reason: "service status could not be determined" };
    }
    if (remaining() <= 0) {
      service = { state: "unknown", reason: "status check timed out" };
    }
    let host: ControlPlaneHostStatus;
    const controller = new AbortController();
    const hostResult = await settleWithin(
      () => deps.fetchHostStatus(identity, controller.signal),
      remaining(),
    );
    if (hostResult.state === "fulfilled") {
      host = hostResult.value;
    } else {
      if (hostResult.state === "timed_out") controller.abort();
      host = {
        reachable: false,
        hostId: identity.hostId,
        online: null,
        connectedAt: null,
        draining: null,
        gitReady: null,
        reason: "control plane is unreachable",
      };
    }
    const ready = statusIsReady(service, host);
    deps.log(
      JSON.stringify(
        {
          status: ready ? "ok" : "failed",
          service,
          controlPlane: host,
          inventory: config ? configuredInventory(config) : null,
        },
        (_key, value: unknown) =>
          typeof value === "string" && identity.apiKey
            ? value.split(identity.apiKey).join("[REDACTED]")
            : value,
        2,
      ),
    );
    return ready ? 0 : 1;
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
    const result = await deps.runSession(config, assign, deps.log, resolvedEnv);
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
    const wsIdx = args.indexOf("--ws");
    const wsUrl = wsIdx >= 0 ? args[wsIdx + 1] : undefined;
    try {
      const { startDaemon } = await import("./start-daemon.ts");
      const config = await deps.loadConfig({ env: resolvedEnv });
      const ready = await deps.ensureReady(config);
      const environmentNames = Object.keys(createChildEnv(resolvedEnv)).toSorted((a, b) =>
        a.localeCompare(b),
      );
      if (
        environmentNames.length > MAX_RUNTIME_ENVIRONMENT_NAMES ||
        environmentNames.some((name) => name.length > MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH)
      ) {
        throw new Error(
          `child environment exceeds runtime report limits (${MAX_RUNTIME_ENVIRONMENT_NAMES} names, ${MAX_RUNTIME_ENVIRONMENT_NAME_LENGTH} characters per name)`,
        );
      }
      const runtime = ready
        ? {
            ...ready,
            environmentNames,
          }
        : ready;
      const { stop } = await startDaemon({
        config,
        identity: loadHostIdentity(resolvedEnv),
        ...(wsUrl !== undefined ? { wsUrl } : {}),
        log: deps.log,
        error: deps.error,
        childEnvSource: resolvedEnv,
        updateBootPrepared,
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
