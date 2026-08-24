import {
  assertHostRepositoryRequiredEnvironmentLimit,
  parseAllowedRoots,
  parseProviderAccountOverrides,
  parseProviderAccounts,
  parseRequiredEnvironment,
  parseHostUpdateConfig,
} from "@auto-harness/shared";

import type { DaemonConfig, RepositoryConfig, WorktreeConfig } from "./config-types.ts";
import { isForeignWindowsAbsolutePath } from "./allowed-roots.ts";

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
    if (isForeignWindowsAbsolutePath(raw.terminalHookScript)) {
      throw new Error(`repository.${id}.terminalHookScript is not valid on ${process.platform}`);
    }
    repo.terminalHookScript = raw.terminalHookScript;
  }
  const requiredEnvironment = parseRequiredEnvironment(
    raw.requiredEnvironment,
    `repository.${id}.requiredEnvironment`,
  );
  if (requiredEnvironment.length) repo.requiredEnvironment = requiredEnvironment;
  const repoOverrides = parseProviderAccountOverrides(
    raw.providerAccountOverrides,
    `repository.${id}`,
  );
  if (repoOverrides !== undefined) {
    repo.providerAccountOverrides = repoOverrides;
  }
  return repo;
}

type ParseDaemonConfigOptions = {
  /** Allow zero repositories (agent registered before host inventory is set). */
  allowEmptyRepositories?: boolean;
};

/** Parse full agent runtime config (host inventory + identity fields). */
export function parseDaemonConfig(
  raw: unknown,
  options: ParseDaemonConfigOptions = {},
): DaemonConfig {
  if (!isRecord(raw)) {
    throw new Error("config root must be an object");
  }
  const hostId = requireString(raw, "hostId", "config");
  if (!Array.isArray(raw.repositories)) {
    throw new Error("repositories must be an array");
  }
  if (raw.repositories.length === 0 && !options.allowEmptyRepositories) {
    throw new Error("repositories must be a non-empty array");
  }

  const config: DaemonConfig = {
    hostId,
    repositories: raw.repositories.map((r, i) => parseRepository(r, i)),
    providerAccounts: parseProviderAccounts(raw.providerAccounts),
  };
  if (raw.setupScript !== undefined) {
    if (typeof raw.setupScript !== "string") {
      throw new TypeError("setupScript must be a string");
    }
    config.setupScript = raw.setupScript;
  }
  const allowedRoots = parseAllowedRoots(raw.allowedRoots);
  if (allowedRoots?.length) config.allowedRoots = allowedRoots;
  const requiredEnvironment = parseRequiredEnvironment(raw.requiredEnvironment);
  for (const repository of config.repositories) {
    assertHostRepositoryRequiredEnvironmentLimit(
      requiredEnvironment,
      repository.requiredEnvironment,
      `repository.${repository.id}.requiredEnvironment`,
    );
  }
  if (requiredEnvironment.length) config.requiredEnvironment = requiredEnvironment;
  if (raw.updateConfig !== undefined) config.updateConfig = parseHostUpdateConfig(raw.updateConfig);
  if (typeof raw.apiUrl === "string") {
    config.apiUrl = raw.apiUrl;
  }
  if (typeof raw.apiKey === "string") {
    config.apiKey = raw.apiKey;
  }
  return config;
}
