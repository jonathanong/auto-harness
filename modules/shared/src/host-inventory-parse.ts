import {
  HOST_CAPABILITIES,
  isHostCapability,
  normalizeHostCapabilities,
  type HostCapability,
} from "./host-capabilities.ts";
import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import { parseProviderAccountOverrides, parseProviderAccounts } from "./provider-account-parse.ts";
import { isValidSlugName, SLUG_NAME_HINT } from "./slug.ts";

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

/** Strictly parse the operator-editable host inventory document. */
export function parseHostInventory(value: unknown): HostInventory {
  if (!isRecord(value)) {
    throw new Error("body must be an object");
  }
  if (value.setupScript !== undefined && typeof value.setupScript !== "string") {
    throw new Error("setupScript must be a string");
  }
  if (!Array.isArray(value.repositories)) {
    throw new Error("repositories must be an array");
  }

  const repositories: HostRepository[] = [];
  for (const [ri, rawRepo] of value.repositories.entries()) {
    if (!isRecord(rawRepo)) {
      throw new Error(`repositories[${ri}] must be an object`);
    }
    const id = requireString(rawRepo, "id", `repositories[${ri}]`);
    const path = requireString(rawRepo, "path", `repository.${id}`);
    const defaultBranch =
      typeof rawRepo.defaultBranch === "string" && rawRepo.defaultBranch.length > 0
        ? rawRepo.defaultBranch
        : "main";
    if (!Array.isArray(rawRepo.worktrees)) {
      throw new Error(`repository.${id}.worktrees must be an array`);
    }

    const worktrees: HostWorktree[] = rawRepo.worktrees.map((rawWorktree, wi) => {
      if (!isRecord(rawWorktree)) {
        throw new Error(`repositories.${id}.worktrees[${wi}] invalid`);
      }
      const worktreeId = requireString(rawWorktree, "id", `worktree[${wi}]`);
      const name = requireString(rawWorktree, "name", `worktree.${worktreeId}`);
      if (!isValidSlugName(name)) {
        throw new Error(`worktree.${worktreeId}.name must be ${SLUG_NAME_HINT}`);
      }
      const worktreePath = requireString(rawWorktree, "path", `worktree.${worktreeId}`);
      if (
        !Array.isArray(rawWorktree.labels) ||
        !rawWorktree.labels.every((label) => typeof label === "string")
      ) {
        throw new Error(`worktree.${worktreeId}.labels must be a string array`);
      }
      const worktree: HostWorktree = {
        id: worktreeId,
        name,
        path: worktreePath,
        labels: rawWorktree.labels as string[],
      };
      if (rawWorktree.setupScript !== undefined) {
        if (typeof rawWorktree.setupScript !== "string") {
          throw new Error(`worktree.${worktreeId}.setupScript must be a string`);
        }
        worktree.setupScript = rawWorktree.setupScript;
      }
      const overrides = parseProviderAccountOverrides(
        rawWorktree.providerAccountOverrides,
        `worktree.${worktreeId}`,
      );
      if (overrides !== undefined) worktree.providerAccountOverrides = overrides;
      return worktree;
    });

    const repository: HostRepository = { id, path, defaultBranch, worktrees };
    if (rawRepo.setupScript !== undefined) {
      if (typeof rawRepo.setupScript !== "string") {
        throw new Error(`repository.${id}.setupScript must be a string`);
      }
      repository.setupScript = rawRepo.setupScript;
    }
    if (rawRepo.terminalHookScript !== undefined) {
      if (typeof rawRepo.terminalHookScript !== "string") {
        throw new Error(`repository.${id}.terminalHookScript must be a string`);
      }
      repository.terminalHookScript = rawRepo.terminalHookScript;
    }
    const overrides = parseProviderAccountOverrides(
      rawRepo.providerAccountOverrides,
      `repository.${id}`,
    );
    if (overrides !== undefined) repository.providerAccountOverrides = overrides;
    repositories.push(repository);
  }

  if (
    value.capabilities !== undefined &&
    (!Array.isArray(value.capabilities) ||
      value.capabilities.length > HOST_CAPABILITIES.length ||
      !value.capabilities.every(isHostCapability) ||
      new Set(value.capabilities).size !== value.capabilities.length)
  ) {
    throw new Error("capabilities must be a supported capability array");
  }

  return {
    ...(typeof value.setupScript === "string" ? { setupScript: value.setupScript } : {}),
    repositories,
    providerAccounts: parseProviderAccounts(value.providerAccounts),
    capabilities: normalizeHostCapabilities(value.capabilities as HostCapability[] | undefined),
  };
}
