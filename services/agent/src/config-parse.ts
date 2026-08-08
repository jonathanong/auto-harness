import { parseProviderAccountOverrides, parseProviderAccounts } from "@auto-harness/shared";

import type {
  AgentConfig,
  CommandProfileConfig,
  RepositoryConfig,
  WorktreeConfig,
} from "./config-types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, key: string, ctx: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${ctx}: ${key} must be a non-empty string`);
  }
  return value;
}

function parseCommandProfiles(raw: unknown): Record<string, CommandProfileConfig> {
  if (!isRecord(raw)) {
    throw new Error("commandProfiles must be an object");
  }
  const out: Record<string, CommandProfileConfig> = {};
  for (const [name, profile] of Object.entries(raw)) {
    if (!isRecord(profile)) {
      throw new Error(`commandProfiles.${name} must be an object`);
    }
    if (
      !Array.isArray(profile.argv) ||
      profile.argv.length === 0 ||
      !profile.argv.every((a) => typeof a === "string" && a.length > 0)
    ) {
      throw new Error(`commandProfiles.${name}.argv must be a non-empty string array`);
    }
    out[name] = {
      argv: profile.argv as string[],
      appendPrompt: profile.appendPrompt !== false,
    };
  }
  return out;
}

function parseWorktree(raw: unknown, index: number, repoId: string): WorktreeConfig {
  if (!isRecord(raw)) {
    throw new Error(`repositories.${repoId}.worktrees[${index}] invalid`);
  }
  const id = requireString(raw, "id", `worktree[${index}]`);
  const name = requireString(raw, "name", `worktree.${id}`);
  const path = requireString(raw, "path", `worktree.${id}`);
  if (!Array.isArray(raw.labels) || !raw.labels.every((l) => typeof l === "string")) {
    throw new Error(`worktree.${id}.labels must be a string array`);
  }
  const wt: WorktreeConfig = {
    id,
    name,
    path,
    labels: raw.labels as string[],
  };
  if (raw.setupScript !== undefined) {
    if (typeof raw.setupScript !== "string") {
      throw new Error(`worktree.${id}.setupScript must be a string`);
    }
    wt.setupScript = raw.setupScript;
  }
  const wtOverrides = parseProviderAccountOverrides(raw.providerAccountOverrides, `worktree.${id}`);
  if (wtOverrides !== undefined) {
    wt.providerAccountOverrides = wtOverrides;
  }
  return wt;
}

function parseRepository(raw: unknown, index: number): RepositoryConfig {
  if (!isRecord(raw)) {
    throw new Error(`repositories[${index}] must be an object`);
  }
  const id = requireString(raw, "id", `repositories[${index}]`);
  const path = requireString(raw, "path", `repository.${id}`);
  const defaultBranch =
    typeof raw.defaultBranch === "string" && raw.defaultBranch.length > 0
      ? raw.defaultBranch
      : "main";
  if (!Array.isArray(raw.worktrees)) {
    throw new Error(`repository.${id}.worktrees must be an array`);
  }
  const repo: RepositoryConfig = {
    id,
    path,
    defaultBranch,
    worktrees: raw.worktrees.map((w, i) => parseWorktree(w, i, id)),
  };
  if (raw.setupScript !== undefined) {
    if (typeof raw.setupScript !== "string") {
      throw new Error(`repository.${id}.setupScript must be a string`);
    }
    repo.setupScript = raw.setupScript;
  }
  if (raw.terminalHookScript !== undefined) {
    if (typeof raw.terminalHookScript !== "string") {
      throw new Error(`repository.${id}.terminalHookScript must be a string`);
    }
    repo.terminalHookScript = raw.terminalHookScript;
  }
  const repoOverrides = parseProviderAccountOverrides(
    raw.providerAccountOverrides,
    `repository.${id}`,
  );
  if (repoOverrides !== undefined) {
    repo.providerAccountOverrides = repoOverrides;
  }
  return repo;
}

type ParseAgentConfigOptions = {
  /** Allow zero repositories (agent registered before host inventory is set). */
  allowEmptyRepositories?: boolean;
};

/** Parse full agent runtime config (host inventory + identity fields). */
export function parseAgentConfig(raw: unknown, options: ParseAgentConfigOptions = {}): AgentConfig {
  if (!isRecord(raw)) {
    throw new Error("config root must be an object");
  }
  const agentId = requireString(raw, "agentId", "config");
  if (!Array.isArray(raw.repositories)) {
    throw new Error("repositories must be an array");
  }
  if (raw.repositories.length === 0 && !options.allowEmptyRepositories) {
    throw new Error("repositories must be a non-empty array");
  }
  const logLevelRaw = raw.logLevel;
  const logLevel =
    logLevelRaw === "debug" ||
    logLevelRaw === "info" ||
    logLevelRaw === "warn" ||
    logLevelRaw === "error"
      ? logLevelRaw
      : "info";

  const config: AgentConfig = {
    agentId,
    repositories: raw.repositories.map((r, i) => parseRepository(r, i)),
    providerAccounts: parseProviderAccounts(raw.providerAccounts),
    commandProfiles: parseCommandProfiles(raw.commandProfiles ?? {}),
    logLevel,
  };
  if (typeof raw.apiUrl === "string") {
    config.apiUrl = raw.apiUrl;
  }
  if (typeof raw.apiKey === "string") {
    config.apiKey = raw.apiKey;
  }
  return config;
}
