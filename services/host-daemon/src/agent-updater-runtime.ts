import { AgentUpdater } from "./agent-updater.ts";
import { createHttpsUpdateFetcher } from "./agent-updater-fetch.ts";
import { createFileUpdateInstaller, readInstalledVersion } from "./agent-updater-install.ts";
import { createSupervisorRestartInstaller } from "./agent-updater-supervisor.ts";
import type { DaemonLoop } from "./daemon-loop.ts";

const DEFAULT_POLL_MS = 60 * 60_000;

type DaemonUpdaterBindings = {
  loop: DaemonLoop;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  error: (line: string) => void;
  service?: Parameters<typeof createSupervisorRestartInstaller>[1];
  fetchFn?: Parameters<typeof createHttpsUpdateFetcher>[1];
  now?: () => string;
};

export function parseUpdatePollMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_POLL_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error("HARNESS_UPDATE_POLL_MS must be a non-negative integer");
  }
  return parsed;
}

export function createDaemonUpdater(bindings: DaemonUpdaterBindings): AgentUpdater | undefined {
  const manifestUrl = bindings.env.HARNESS_UPDATE_MANIFEST_URL?.trim();
  const publicKey = bindings.env.HARNESS_UPDATE_PUBLIC_KEY?.trim();
  if (!manifestUrl && !publicKey) return undefined;
  if (!manifestUrl || !publicKey) {
    throw new Error("HARNESS_UPDATE_MANIFEST_URL and HARNESS_UPDATE_PUBLIC_KEY are both required");
  }
  if (!bindings.service) throw new Error("supervisor restart adapter is required");
  const installDir = bindings.env.HARNESS_UPDATE_INSTALL_DIR?.trim() || "/opt/auto-harness";
  const configuredVersion = bindings.env.HARNESS_DAEMON_VERSION?.trim();
  const currentVersion = readInstalledVersion(installDir) ?? configuredVersion ?? "0.0.0";
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
      drain: () => bindings.loop.beginDrain(),
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
): () => void {
  let stopped = false;
  let inFlight = false;
  const run = (): void => {
    if (stopped || inFlight) return;
    inFlight = true;
    void updater
      .run()
      .catch((error: unknown) => {
        options.error(`updater failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  };
  run();
  if (options.pollMs === 0)
    return () => {
      stopped = true;
    };
  const timer = setInterval(run, options.pollMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
