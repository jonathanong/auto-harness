import type { DaemonConfig } from "./config.ts";
import type { RunSessionDeps } from "./cli.ts";

export const sampleConfig: DaemonConfig = {
  hostId: "a1",
  providerAccounts: [],
  repositories: [
    {
      id: "repo-1",
      path: "/repo",
      defaultBranch: "main",
      worktrees: [{ id: "wt-1", name: "wt-1", path: "/repo/wt-1", labels: ["codex"] }],
    },
  ],
};

export function deps(partial: Partial<RunSessionDeps> = {}): RunSessionDeps & {
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (m) => {
      logs.push(m);
    },
    error: (m) => {
      errors.push(m);
    },
    readFile: () =>
      JSON.stringify({
        sessionId: "s1",
        repositoryId: "repo-1",
        prompt: "p",
        resolvedArgv: ["echo"],
        timeout: 5,
        worktreeId: "wt-1",
      }),
    loadConfig: async () => sampleConfig,
    ensureReady: async () => undefined,
    runSession: async () => ({
      status: "completed",
      exitCode: 0,
      logs: [],
    }),
    installService: () => 0,
    uninstallService: () => 0,
    statusService: () => ({ state: "running", reason: "test service" }),
    fetchHostStatus: async (identity) => ({
      reachable: true,
      hostId: identity.hostId,
      online: true,
      connectedAt: "2026-01-01T00:00:00.000Z",
      draining: false,
      gitReady: true,
      reason: "test host",
    }),
    ...partial,
  };
}
