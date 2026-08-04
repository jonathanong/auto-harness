/** Host inventory owned by the control plane (configured via API/UI). */

export type CommandProfileDef = {
  /** Fixed argv prefix; never a shell string (D4). */
  argv: string[];
  /** When true, session prompt is appended as the final argv element. */
  appendPrompt: boolean;
};

export type HostWorktreeConfig = {
  /** Auto-generated (UUIDv7), immutable. */
  id: string;
  /** User-chosen, slug-validated, unique across all hosts. */
  name: string;
  path: string;
  labels: string[];
  setupScript?: string;
};

export type HostRepositoryConfig = {
  id: string;
  /** Absolute path on the agent host. */
  path: string;
  defaultBranch: string;
  setupScript?: string;
  terminalHookScript?: string;
  worktrees: HostWorktreeConfig[];
};

/**
 * Per-agent host inventory. Agent process only needs identity env vars;
 * this document is fetched from the control plane on start.
 */
export type AgentHostConfig = {
  agentId: string;
  repositories: HostRepositoryConfig[];
  commandProfiles: Record<string, CommandProfileDef>;
  logLevel?: "debug" | "info" | "warn" | "error";
  updatedAt?: string;
};
