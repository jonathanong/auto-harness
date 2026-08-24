/** Enable/command override for a provider account at a repository or worktree scope. */
type ProviderAccountOverride = {
  enabled?: boolean;
  commandId?: string;
};

export type WorktreeConfig = {
  id: string;
  name: string;
  path: string;
  labels: string[];
  setupScript?: string;
  providerAccountOverrides?: Record<string, ProviderAccountOverride>;
};

export type RepositoryConfig = {
  id: string;
  path: string;
  defaultBranch: string;
  setupScript?: string;
  terminalHookScript?: string;
  requiredEnvironment?: string[];
  worktrees: WorktreeConfig[];
  providerAccountOverrides?: Record<string, ProviderAccountOverride>;
};

/** A provider account attached to a host, with an optional command override. */
type HostProviderAccountConfig = {
  providerAccountId: string;
  commandId?: string;
};

/** Runtime config after bootstrap (identity + host inventory from control plane). */
export type DaemonConfig = {
  hostId: string;
  apiUrl?: string;
  apiKey?: string;
  setupScript?: string;
  allowedRoots?: string[];
  requiredEnvironment?: string[];
  repositories: RepositoryConfig[];
  providerAccounts: HostProviderAccountConfig[];
};

/** Process identity only — the only values the agent binary needs from env. */
export type HostIdentity = {
  hostId: string;
  /** Control plane base URL (http(s) or ws(s)). */
  apiUrl: string;
  /** Service-account token (`hns_…`); optional for unsecured local stacks. */
  apiKey?: string;
};

export function findRepository(
  config: DaemonConfig,
  repositoryId: string,
): RepositoryConfig | undefined {
  return config.repositories.find((r) => r.id === repositoryId);
}

export function findWorktree(
  config: DaemonConfig,
  repositoryId: string,
  worktreeId: string,
): WorktreeConfig | undefined {
  return findRepository(config, repositoryId)?.worktrees.find((w) => w.id === worktreeId);
}
