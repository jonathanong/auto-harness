import { AgentUpdater } from "./agent-updater.ts";
import { createHttpsUpdateFetcher } from "./agent-updater-fetch.ts";
import {
  confirmPendingUpdateBoot,
  createFileUpdateInstaller,
  recoverPendingUpdateBoot,
  readInstalledVersion,
  type UpdateBootRecovery,
} from "./agent-updater-install.ts";
import { createSupervisorRestartInstaller } from "./agent-updater-supervisor.ts";
import { resolveUpdateInstallDir } from "./update-install-dir.ts";
import type { DaemonLoop } from "./daemon-loop.ts";

const DEFAULT_POLL_MS = 60 * 60_000;
export const MAX_UPDATE_POLL_MS = 2_147_483_647;

type DaemonUpdaterBindings = {
  loop: DaemonLoop;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  error: (line: string) => void;
  service?: Parameters<typeof createSupervisorRestartInstaller>[1];
  fetchFn?: Parameters<typeof createHttpsUpdateFetcher>[1];
  now?: () => string;
};

type DaemonUpdateBootBindings = Pick<DaemonUpdaterBindings, "env" | "service">;

function daemonUpdateInstallDir(bindings: DaemonUpdateBootBindings): string {
  return resolveUpdateInstallDir(bindings.env, {
    ...(bindings.service?.platform !== undefined ? { platform: bindings.service.platform } : {}),
    ...(bindings.service?.home !== undefined ? { home: bindings.service.home } : {}),
    ...(bindings.service?.appData !== undefined ? { appData: bindings.service.appData } : {}),
  });
}

/**
 * Record the first replacement boot or roll back an earlier replacement that
 * crashed before it registered. This is intentionally available before the
 * updater itself is configured so removing update settings cannot bypass an
 * already-pending safety marker.
 */
export function recoverDaemonUpdateBoot(
  bindings: DaemonUpdateBootBindings,
): Promise<UpdateBootRecovery> {
  return recoverPendingUpdateBoot({
    rootDir: daemonUpdateInstallDir(bindings),
    ...(bindings.service?.platform !== undefined
      ? { platform: bindings.service.platform as NodeJS.Platform }
      : {}),
  });
}

/** A connected-and-registered daemon is the durable health acknowledgement for its release. */
export function confirmDaemonUpdateBoot(bindings: DaemonUpdateBootBindings): boolean {
  return confirmPendingUpdateBoot(daemonUpdateInstallDir(bindings));
}

export function parseUpdatePollMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_POLL_MS;
  const parsed = Number(raw);
  assertUpdatePollMs(parsed);
  return parsed;
}

function assertUpdatePollMs(pollMs: number): void {
  if (!Number.isInteger(pollMs) || pollMs < 0 || pollMs > MAX_UPDATE_POLL_MS) {
    throw new Error(
      `HARNESS_UPDATE_POLL_MS must be an integer between 0 and ${MAX_UPDATE_POLL_MS}`,
    );
  }
}

export function createDaemonUpdater(bindings: DaemonUpdaterBindings): AgentUpdater | undefined {
  const manifestUrl = bindings.env.HARNESS_UPDATE_MANIFEST_URL?.trim();
  const publicKey = bindings.env.HARNESS_UPDATE_PUBLIC_KEY?.trim().replaceAll("\\n", "\n");
  if (!manifestUrl && !publicKey) return undefined;
  if (!manifestUrl || !publicKey) {
    throw new Error("HARNESS_UPDATE_MANIFEST_URL and HARNESS_UPDATE_PUBLIC_KEY are both required");
  }
  if (!bindings.service) throw new Error("supervisor restart adapter is required");
  const installDir = daemonUpdateInstallDir(bindings);
  const installedVersion = readInstalledVersion(installDir);
  const configuredVersion = bindings.env.HARNESS_DAEMON_VERSION?.trim();
  const currentVersion = installedVersion ?? configuredVersion ?? "0.0.0";
  const files = createFileUpdateInstaller({
    rootDir: installDir,
    currentVersion,
  });
  const installer = createSupervisorRestartInstaller(files, bindings.service);
  return new AgentUpdater({
    currentVersion,
    manifestPublicKey: publicKey,
    fetcher: createHttpsUpdateFetcher(manifestUrl, bindings.fetchFn),
    lifecycle: {
      drain: async () => {
        // beginDrain() is intentionally idempotent for operator and policy
        // drains. Capture ownership before entering it so a failed update
        // cannot resume a maintenance drain that it did not acquire.
        const alreadyDraining = bindings.loop.isDraining();
        await bindings.loop.beginDrain();
        return !alreadyDraining;
      },
      waitForIdle: () => bindings.loop.waitForIdle(),
      resume: () => bindings.loop.resumeFromDrain(),
    },
    installer,
    onState: (state) => {
      bindings.log(`updater ${state.phase}${state.phase === "failed" ? `: ${state.error}` : ""}`);
    },
  });
}

export function startUpdatePoll(
  updater: AgentUpdater,
  options: {
    pollMs: number;
    log: (line: string) => void;
    error: (line: string) => void;
  },
): () => Promise<void> {
  assertUpdatePollMs(options.pollMs);
  let stopped = false;
  let active: Promise<void> | undefined;
  const run = (): void => {
    if (stopped || active) return;
    const pending: Promise<void> = updater
      .run()
      .then(() => undefined)
      .catch((error: unknown) => {
        options.error(`updater failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (active === pending) active = undefined;
      });
    active = pending;
  };
  run();
  if (options.pollMs === 0)
    return async () => {
      stopped = true;
      await active;
    };
  const timer = setInterval(run, options.pollMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await active;
  };
}
