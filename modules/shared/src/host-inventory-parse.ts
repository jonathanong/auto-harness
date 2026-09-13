/* eslint-disable max-lines -- strict inventory parsing stays colocated with its field rules. */
import {
  HOST_CAPABILITIES,
  isHostCapability,
  normalizeHostCapabilities,
  type HostCapability,
} from "./host-capabilities.ts";
import { HOST_PROTOCOL_VERSION } from "./constants.ts";
import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import { MAX_HOST_REGISTRATION_BYTES } from "./host-registration.ts";
import {
  workspaceSlotIdByteLengthError,
  type WorkspacePoolAttachment,
  type WorkspaceSlot,
} from "./workspace.ts";
import { parseProviderAccountOverrides, parseProviderAccounts } from "./provider-account-parse.ts";
import { isValidSlugName, SLUG_NAME_HINT } from "./slug.ts";
import {
  assertHostRepositoryRequiredEnvironmentLimit,
  parseRequiredEnvironment,
} from "./environment-requirements.ts";
import { parseAllowedRoots, parseTerminalHookScript } from "./host-exec-config.ts";
import { parseHostUpdateConfig } from "./host-update-config.ts";
import { parseSetupCacheInputs } from "./setup-cache-inputs.ts";

// Registration also carries daemon identity/runtime and reconnect metadata that is not part of
// the persisted inventory. Keep a conservative cushion so an inventory near the frame limit
// cannot become oversized when those bounded fields are added by the daemon.
const HOST_REGISTRATION_INVENTORY_HEADROOM_BYTES = 8 * 1_024;

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

function optionalCacheInputs(
  raw: Record<string, unknown>,
  ctx: string,
): { setupCacheInputs: string[] } | Record<string, never> {
  if (!Object.hasOwn(raw, "setupCacheInputs")) return {};
  return { setupCacheInputs: parseSetupCacheInputs(raw.setupCacheInputs, ctx) ?? [] };
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
    ...optionalCacheInputs(rawWorktree, `worktree.${id}.setupCacheInputs`),
    ...(overrides !== undefined ? { providerAccountOverrides: overrides } : {}),
  };
}

type ParseHostInventoryOptions = {
  /**
   * Existing documents written before terminal hooks were restricted can be
   * read-modify-written unchanged. Reconciliation verifies that a relative
   * value really is unchanged before it reaches durable storage.
   */
  allowLegacyRelativeTerminalHooks?: boolean;
};

function parseRepository(
  rawRepository: unknown,
  index: number,
  options: ParseHostInventoryOptions,
): HostRepository {
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
  const terminalHookScript = parseTerminalHookScript(
    optionalString(rawRepository, "terminalHookScript", `repository.${id}`),
    id,
    { allowLegacyRelative: options.allowLegacyRelativeTerminalHooks === true },
  );
  const requiredEnvironment = parseRequiredEnvironment(
    rawRepository.requiredEnvironment,
    `repository.${id}.requiredEnvironment`,
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
    ...optionalCacheInputs(rawRepository, `repository.${id}.setupCacheInputs`),
    ...(terminalHookScript !== undefined ? { terminalHookScript } : {}),
    ...(requiredEnvironment.length ? { requiredEnvironment } : {}),
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

function parseWorkspacePools(value: unknown): WorkspacePoolAttachment[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError("workspacePools must be an array");
  const pools = value.map((rawPool, poolIndex): WorkspacePoolAttachment => {
    if (!isRecord(rawPool)) throw new TypeError(`workspacePools[${poolIndex}] invalid`);
    const workspacePoolId = requireString(
      rawPool,
      "workspacePoolId",
      `workspacePools[${poolIndex}]`,
    );
    if (!Array.isArray(rawPool.slots)) {
      throw new TypeError(`workspacePools.${workspacePoolId}.slots must be an array`);
    }
    const slots = rawPool.slots.map((rawSlot, slotIndex): WorkspaceSlot => {
      if (!isRecord(rawSlot)) {
        throw new TypeError(`workspacePools.${workspacePoolId}.slots[${slotIndex}] invalid`);
      }
      const id = requireString(
        rawSlot,
        "id",
        `workspacePools.${workspacePoolId}.slots[${slotIndex}]`,
      );
      const idByteLengthError = workspaceSlotIdByteLengthError(id);
      if (idByteLengthError) throw new TypeError(idByteLengthError);
      return {
        id,
        name: requireString(
          rawSlot,
          "name",
          `workspacePools.${workspacePoolId}.slots[${slotIndex}]`,
        ),
        path: requireString(
          rawSlot,
          "path",
          `workspacePools.${workspacePoolId}.slots[${slotIndex}]`,
        ),
      };
    });
    if (new Set(slots.map((slot) => slot.id)).size !== slots.length) {
      throw new TypeError(`workspacePools.${workspacePoolId}.slots ids must be unique`);
    }
    return { workspacePoolId, slots };
  });
  if (new Set(pools.map((pool) => pool.workspacePoolId)).size !== pools.length) {
    throw new TypeError("workspacePools ids must be unique");
  }
  const slotIds = new Set<string>();
  for (const pool of pools) {
    for (const slot of pool.slots) {
      if (slotIds.has(slot.id)) {
        throw new TypeError(`workspace slot ids must be unique: ${slot.id}`);
      }
      slotIds.add(slot.id);
    }
  }
  return pools;
}

/**
 * Estimate the daemon's serialized registration from operator-owned inventory fields.
 * Runtime advertisements add only bounded protocol metadata; applying the shared frame cap
 * here prevents an accepted inventory from being impossible for the daemon to advertise.
 */
function hostRegistrationByteLength(inventory: HostInventory): number {
  const registration = {
    type: "host:register",
    hostId: "host",
    worktrees: inventory.repositories.flatMap((repository) =>
      repository.worktrees.map((worktree) => ({
        id: worktree.id,
        name: worktree.name,
        repositoryId: repository.id,
        path: worktree.path,
        labels: worktree.labels,
      })),
    ),
    repositories: inventory.repositories.map(({ id, path, defaultBranch }) => ({
      id,
      path,
      defaultBranch,
    })),
    ...(inventory.workspacePools !== undefined ? { workspacePools: inventory.workspacePools } : {}),
    capabilities: {
      features: ["scheduled-main-checkout", "workspace-sessions"],
    },
    providerAccountReadiness: [],
    protocolVersion: HOST_PROTOCOL_VERSION,
    runningSessions: [],
    runningAttempts: [],
  };
  return new TextEncoder().encode(JSON.stringify(registration)).length;
}

/** Strictly parse the operator-editable host inventory document. */
export function parseHostInventory(
  value: unknown,
  options: ParseHostInventoryOptions = {},
): HostInventory {
  if (!isRecord(value)) {
    throw new TypeError("body must be an object");
  }
  const setupScript = optionalString(value, "setupScript");
  const allowedRoots = parseAllowedRoots(value.allowedRoots);
  const requiredEnvironment = parseRequiredEnvironment(value.requiredEnvironment);
  const updateConfig =
    value.updateConfig === undefined ? undefined : parseHostUpdateConfig(value.updateConfig);
  const workspacePools = parseWorkspacePools(value.workspacePools);
  if (!Array.isArray(value.repositories)) {
    throw new TypeError("repositories must be an array");
  }
  const repositories = value.repositories.map((repository, index) =>
    parseRepository(repository, index, options),
  );
  for (const repository of repositories) {
    assertHostRepositoryRequiredEnvironmentLimit(
      requiredEnvironment,
      repository.requiredEnvironment,
      `repository.${repository.id}.requiredEnvironment`,
    );
  }

  const inventory: HostInventory = {
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...optionalCacheInputs(value, "setupCacheInputs"),
    ...(allowedRoots !== undefined ? { allowedRoots } : {}),
    ...(requiredEnvironment.length ? { requiredEnvironment } : {}),
    ...(updateConfig !== undefined ? { updateConfig } : {}),
    ...(workspacePools !== undefined ? { workspacePools } : {}),
    repositories,
    providerAccounts: parseProviderAccounts(value.providerAccounts),
    capabilities: parseCapabilities(value.capabilities),
  };
  if (
    hostRegistrationByteLength(inventory) >
    MAX_HOST_REGISTRATION_BYTES - HOST_REGISTRATION_INVENTORY_HEADROOM_BYTES
  ) {
    throw new TypeError(
      `host registration must be at most ${MAX_HOST_REGISTRATION_BYTES} serialized bytes`,
    );
  }
  return inventory;
}
