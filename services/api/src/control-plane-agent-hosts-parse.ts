import {
  HOST_CAPABILITIES,
  isHostCapability,
  isValidSlugName,
  normalizeHostCapabilities,
  parseProviderAccountOverrides,
  parseProviderAccounts,
  SLUG_NAME_HINT,
} from "@auto-harness/shared";

import type { HostInventoryRecord } from "./db/plane-storage.ts";

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

export function parseHostBody(
  hostId: string,
  body: unknown,
): Omit<HostInventoryRecord, "updatedAt"> {
  if (!isRecord(body)) {
    throw new Error("body must be an object");
  }
  if (body.hostId !== undefined && body.hostId !== hostId) {
    throw new Error("body.hostId must match path hostId");
  }
  if (body.setupScript !== undefined && typeof body.setupScript !== "string") {
    throw new Error("setupScript must be a string");
  }
  // Empty repositories allowed: register agent / seed host before attaching repos.
  if (!Array.isArray(body.repositories)) {
    throw new Error("repositories must be an array");
  }
  const repositories: HostInventoryRecord["repositories"] = [];
  for (const [ri, rawRepo] of body.repositories.entries()) {
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
    const worktrees = rawRepo.worktrees.map((rawWt, wi) => {
      if (!isRecord(rawWt)) {
        throw new Error(`repositories.${id}.worktrees[${wi}] invalid`);
      }
      const wtId = requireString(rawWt, "id", `worktree[${wi}]`);
      const wtName = requireString(rawWt, "name", `worktree.${wtId}`);
      if (!isValidSlugName(wtName)) {
        throw new Error(`worktree.${wtId}.name must be ${SLUG_NAME_HINT}`);
      }
      const wtPath = requireString(rawWt, "path", `worktree.${wtId}`);
      if (!Array.isArray(rawWt.labels) || !rawWt.labels.every((l) => typeof l === "string")) {
        throw new Error(`worktree.${wtId}.labels must be a string array`);
      }
      const wt: HostInventoryRecord["repositories"][0]["worktrees"][0] = {
        id: wtId,
        name: wtName,
        path: wtPath,
        labels: rawWt.labels as string[],
      };
      if (rawWt.setupScript !== undefined) {
        if (typeof rawWt.setupScript !== "string") {
          throw new Error(`worktree.${wtId}.setupScript must be a string`);
        }
        wt.setupScript = rawWt.setupScript;
      }
      const wtOverrides = parseProviderAccountOverrides(
        rawWt.providerAccountOverrides,
        `worktree.${wtId}`,
      );
      if (wtOverrides !== undefined) {
        wt.providerAccountOverrides = wtOverrides;
      }
      return wt;
    });
    const repo: HostInventoryRecord["repositories"][0] = { id, path, defaultBranch, worktrees };
    if (rawRepo.setupScript !== undefined) {
      if (typeof rawRepo.setupScript !== "string") {
        throw new Error(`repository.${id}.setupScript must be a string`);
      }
      repo.setupScript = rawRepo.setupScript;
    }
    if (rawRepo.terminalHookScript !== undefined) {
      if (typeof rawRepo.terminalHookScript !== "string") {
        throw new Error(`repository.${id}.terminalHookScript must be a string`);
      }
      repo.terminalHookScript = rawRepo.terminalHookScript;
    }
    const repoOverrides = parseProviderAccountOverrides(
      rawRepo.providerAccountOverrides,
      `repository.${id}`,
    );
    if (repoOverrides !== undefined) {
      repo.providerAccountOverrides = repoOverrides;
    }
    repositories.push(repo);
  }

  const providerAccounts = parseProviderAccounts(body.providerAccounts);

  if (
    body.capabilities !== undefined &&
    (!Array.isArray(body.capabilities) ||
      body.capabilities.length > HOST_CAPABILITIES.length ||
      !body.capabilities.every(isHostCapability) ||
      new Set(body.capabilities).size !== body.capabilities.length)
  ) {
    throw new Error("capabilities must be a supported capability array");
  }
  const capabilities = normalizeHostCapabilities(
    body.capabilities as import("@auto-harness/shared").HostCapability[] | undefined,
  );

  return {
    hostId,
    ...(typeof body.setupScript === "string" ? { setupScript: body.setupScript } : {}),
    repositories,
    providerAccounts,
    capabilities,
  };
}
