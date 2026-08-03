export type CommandProfileConfig = {
  /** Fixed argv prefix; never a shell string. */
  argv: string[];
  /** When true, session prompt is appended as the final argv element. */
  appendPrompt: boolean;
};

export type WorktreeConfig = {
  id: string;
  path: string;
  labels: string[];
  setupScript?: string;
};

export type RepositoryConfig = {
  id: string;
  path: string;
  defaultBranch: string;
  setupScript?: string;
  terminalHookScript?: string;
  worktrees: WorktreeConfig[];
};

/** Runtime config after bootstrap (identity + host inventory from control plane). */
export type AgentConfig = {
  agentId: string;
  apiUrl?: string;
  apiKey?: string;
  repositories: RepositoryConfig[];
  commandProfiles: Record<string, CommandProfileConfig>;
  logLevel: "debug" | "info" | "warn" | "error";
};

/** Process identity only — the only values the agent binary needs from env. */
export type AgentIdentity = {
  agentId: string;
  /** Control plane base URL (http(s) or ws(s)). */
  apiUrl: string;
  /** Service-account token (`hns_…`); optional for unsecured local stacks. */
  apiKey?: string;
  logLevel: "debug" | "info" | "warn" | "error";
};

export function findRepository(
  config: AgentConfig,
  repositoryId: string,
): RepositoryConfig | undefined {
  return config.repositories.find((r) => r.id === repositoryId);
}

export function findWorktree(
  config: AgentConfig,
  repositoryId: string,
  worktreeId: string,
): WorktreeConfig | undefined {
  return findRepository(config, repositoryId)?.worktrees.find((w) => w.id === worktreeId);
}
