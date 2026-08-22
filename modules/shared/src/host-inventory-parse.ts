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
    throw new TypeError(`${ctx}: ${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
  ctx?: string,
): string | undefined {
  const value = obj[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    const prefix = ctx ? `${ctx}.` : "";
    throw new TypeError(`${prefix}${key} must be a string`);
  }
  return value;
}

function parseWorktree(rawWorktree: unknown, index: number, repositoryId: string): HostWorktree {
  if (!isRecord(rawWorktree)) {
    throw new TypeError(`repositories.${repositoryId}.worktrees[${index}] invalid`);
  }
  const id = requireString(rawWorktree, "id", `worktree[${index}]`);
  const name = requireString(rawWorktree, "name", `worktree.${id}`);
  if (!isValidSlugName(name)) {
    throw new TypeError(`worktree.${id}.name must be ${SLUG_NAME_HINT}`);
  }
  const path = requireString(rawWorktree, "path", `worktree.${id}`);
  if (
    !Array.isArray(rawWorktree.labels) ||
    !rawWorktree.labels.every((label) => typeof label === "string")
  ) {
    throw new TypeError(`worktree.${id}.labels must be a string array`);
  }
  const setupScript = optionalString(rawWorktree, "setupScript", `worktree.${id}`);
  const overrides = parseProviderAccountOverrides(
    rawWorktree.providerAccountOverrides,
    `worktree.${id}`,
  );
  return {
    id,
    name,
    path,
    labels: rawWorktree.labels as string[],
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...(overrides !== undefined ? { providerAccountOverrides: overrides } : {}),
  };
}

function parseRepository(rawRepository: unknown, index: number): HostRepository {
  if (!isRecord(rawRepository)) {
    throw new TypeError(`repositories[${index}] must be an object`);
  }
  const id = requireString(rawRepository, "id", `repositories[${index}]`);
  const path = requireString(rawRepository, "path", `repository.${id}`);
  const defaultBranch =
    typeof rawRepository.defaultBranch === "string" && rawRepository.defaultBranch.length > 0
      ? rawRepository.defaultBranch
      : "main";
  if (!Array.isArray(rawRepository.worktrees)) {
    throw new TypeError(`repository.${id}.worktrees must be an array`);
  }
  const setupScript = optionalString(rawRepository, "setupScript", `repository.${id}`);
  const terminalHookScript = optionalString(
    rawRepository,
    "terminalHookScript",
    `repository.${id}`,
  );
  const overrides = parseProviderAccountOverrides(
    rawRepository.providerAccountOverrides,
    `repository.${id}`,
  );
  return {
    id,
    path,
    defaultBranch,
    worktrees: rawRepository.worktrees.map((worktree, worktreeIndex) =>
      parseWorktree(worktree, worktreeIndex, id),
    ),
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...(terminalHookScript !== undefined ? { terminalHookScript } : {}),
    ...(overrides !== undefined ? { providerAccountOverrides: overrides } : {}),
  };
}

function parseCapabilities(value: unknown): HostCapability[] {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.length > HOST_CAPABILITIES.length ||
      !value.every(isHostCapability) ||
      new Set(value).size !== value.length)
  ) {
    throw new TypeError("capabilities must be a supported capability array");
  }
  return normalizeHostCapabilities(value as HostCapability[] | undefined);
}

/** Strictly parse the operator-editable host inventory document. */
export function parseHostInventory(value: unknown): HostInventory {
  if (!isRecord(value)) {
    throw new TypeError("body must be an object");
  }
  const setupScript = optionalString(value, "setupScript");
  if (!Array.isArray(value.repositories)) {
    throw new TypeError("repositories must be an array");
  }

  return {
    ...(setupScript !== undefined ? { setupScript } : {}),
    repositories: value.repositories.map((repository, index) => parseRepository(repository, index)),
    providerAccounts: parseProviderAccounts(value.providerAccounts),
    capabilities: parseCapabilities(value.capabilities),
  };
}
