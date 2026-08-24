/* eslint-disable max-lines -- apply, preserve, and inventory-write policy share one module. */
import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import {
  EXEC_CONFIG_REQUIRED_MESSAGE,
  isAbsolutePathString,
  type HostExecConfigPatch,
} from "./host-exec-config-parse.ts";

export {
  MAX_ALLOWED_ROOTS,
  MAX_EXEC_PATH_LENGTH,
  isAbsolutePathString,
  parseAllowedRoots,
  parseHostExecConfig,
  parseTerminalHookScript,
  type HostExecConfigPatch,
  type HostExecRepositoryPatch,
  type HostExecWorktreePatch,
} from "./host-exec-config-parse.ts";

/** Path-level gate for setup scripts, terminal hooks, and allowed roots. */
export const EXEC_CONFIG_CAPABILITY = "fleet:exec-config" as const;

export { EXEC_CONFIG_REQUIRED_MESSAGE } from "./host-exec-config-parse.ts";

function assignOptionalString<T extends object>(target: T, key: keyof T, value: string): void {
  if (value.length === 0) delete target[key];
  else (target[key] as string) = value;
}

function requireRepository(inventory: HostInventory, repositoryId: string): HostRepository {
  const repository = inventory.repositories.find((entry) => entry.id === repositoryId);
  if (!repository) throw new Error(`Unknown repository: ${repositoryId}`);
  return repository;
}

function requireWorktree(repository: HostRepository, worktreeId: string): HostWorktree {
  const worktree = repository.worktrees.find((entry) => entry.id === worktreeId);
  if (!worktree) throw new Error(`Unknown worktree: ${worktreeId}`);
  return worktree;
}

/** Merge an exec-config patch onto inventory without touching ordinary inventory fields. */
export function applyHostExecConfig(
  existing: HostInventory,
  patch: HostExecConfigPatch,
): HostInventory {
  const next: HostInventory = {
    ...existing,
    ...(existing.allowedRoots !== undefined ? { allowedRoots: [...existing.allowedRoots] } : {}),
    ...(existing.requiredEnvironment !== undefined
      ? { requiredEnvironment: [...existing.requiredEnvironment] }
      : {}),
    repositories: existing.repositories.map((repository) => ({
      ...repository,
      worktrees: repository.worktrees.map((worktree) => ({
        ...worktree,
        labels: [...worktree.labels],
      })),
    })),
    providerAccounts: existing.providerAccounts.map((account) => ({ ...account })),
    capabilities: [...(existing.capabilities ?? [])],
  };
  if (patch.setupScript !== undefined) assignOptionalString(next, "setupScript", patch.setupScript);
  if (patch.allowedRoots !== undefined) {
    if (patch.allowedRoots.length) next.allowedRoots = [...patch.allowedRoots];
    else delete next.allowedRoots;
  }
  for (const repositoryPatch of patch.repositories ?? []) {
    const repository = requireRepository(next, repositoryPatch.id);
    if (repositoryPatch.setupScript !== undefined) {
      assignOptionalString(repository, "setupScript", repositoryPatch.setupScript);
    }
    if (repositoryPatch.terminalHookScript !== undefined) {
      assignOptionalString(repository, "terminalHookScript", repositoryPatch.terminalHookScript);
    }
    for (const worktreePatch of repositoryPatch.worktrees ?? []) {
      const worktree = requireWorktree(repository, worktreePatch.id);
      if (worktreePatch.setupScript !== undefined) {
        assignOptionalString(worktree, "setupScript", worktreePatch.setupScript);
      }
    }
  }
  return next;
}

function sameOptionalString(left: string | undefined, right: string | undefined): boolean {
  return (left ?? "") === (right ?? "");
}

function sameRoots(left: string[] | undefined, right: string[] | undefined): boolean {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function entriesById<T extends { id: string }>(entries: readonly T[] | undefined): Map<string, T> {
  return new Map(entries?.map((entry) => [entry.id, entry]) ?? []);
}

function duplicateInventoryIdError(inventory: HostInventory): string | undefined {
  const repositories = new Set<string>();
  const worktrees = new Set<string>();
  for (const repository of inventory.repositories) {
    if (repositories.has(repository.id)) return `duplicate repository ${repository.id}`;
    repositories.add(repository.id);
    for (const worktree of repository.worktrees) {
      if (worktrees.has(worktree.id)) return `duplicate worktree ${worktree.id}`;
      worktrees.add(worktree.id);
    }
  }
  return undefined;
}

function idsInOrder<T extends { id: string }>(
  existing: readonly T[] | undefined,
  incoming: readonly T[] | undefined,
): string[] {
  const ids = new Set<string>();
  const ordered: string[] = [];
  for (const entry of [...(existing ?? []), ...(incoming ?? [])]) {
    if (ids.has(entry.id)) continue;
    ids.add(entry.id);
    ordered.push(entry.id);
  }
  return ordered;
}

function addOptionalStringEdit(
  edits: string[],
  path: string,
  existing: string | undefined,
  incoming: string | undefined,
): void {
  if (!sameOptionalString(existing, incoming)) edits.push(path);
}

/**
 * A relative hook is accepted only when a legacy document supplies the exact
 * same value. New or changed hooks must be absolute even for admins.
 */
function legacyRelativeHookError(
  existing: HostInventory | null | undefined,
  incoming: HostInventory,
): string | undefined {
  const previousRepositories = entriesById(existing?.repositories);
  for (const repository of incoming.repositories) {
    const hook = repository.terminalHookScript;
    if (hook === undefined || hook.length === 0 || isAbsolutePathString(hook)) continue;
    if (previousRepositories.get(repository.id)?.terminalHookScript === hook) continue;
    return `repository.${repository.id}.terminalHookScript must be an absolute path`;
  }
  return undefined;
}

/** True when deleting this inventory would erase admin-controlled executable paths. */
export function inventoryHasExecConfig(inventory: HostInventory | null | undefined): boolean {
  if (!inventory) return false;
  if ((inventory.setupScript ?? "") !== "" || (inventory.allowedRoots ?? []).length > 0)
    return true;
  return inventory.repositories.some(
    (repository) =>
      (repository.setupScript ?? "") !== "" ||
      (repository.terminalHookScript ?? "") !== "" ||
      repository.worktrees.some((worktree) => (worktree.setupScript ?? "") !== ""),
  );
}

/** Field paths whose final persisted exec-config values differ from the existing document. */
export function listExecConfigEdits(
  existing: HostInventory | null | undefined,
  incoming: HostInventory,
): string[] {
  const edits: string[] = [];
  addOptionalStringEdit(edits, "setupScript", existing?.setupScript, incoming.setupScript);
  if (!sameRoots(existing?.allowedRoots, incoming.allowedRoots)) edits.push("allowedRoots");

  const previousRepositories = entriesById(existing?.repositories);
  const incomingRepositories = entriesById(incoming.repositories);
  for (const repositoryId of idsInOrder(existing?.repositories, incoming.repositories)) {
    const previous = previousRepositories.get(repositoryId);
    const next = incomingRepositories.get(repositoryId);
    addOptionalStringEdit(
      edits,
      `repositories.${repositoryId}.setupScript`,
      previous?.setupScript,
      next?.setupScript,
    );
    addOptionalStringEdit(
      edits,
      `repositories.${repositoryId}.terminalHookScript`,
      previous?.terminalHookScript,
      next?.terminalHookScript,
    );
    const previousWorktrees = entriesById(previous?.worktrees);
    const nextWorktrees = entriesById(next?.worktrees);
    for (const worktreeId of idsInOrder(previous?.worktrees, next?.worktrees)) {
      addOptionalStringEdit(
        edits,
        `repositories.${repositoryId}.worktrees.${worktreeId}.setupScript`,
        previousWorktrees.get(worktreeId)?.setupScript,
        nextWorktrees.get(worktreeId)?.setupScript,
      );
    }
  }
  return edits;
}

function restoreScript<T extends { setupScript?: string | undefined }>(
  target: T,
  previous: T | undefined,
): void {
  if (previous?.setupScript !== undefined) target.setupScript = previous.setupScript;
  else delete target.setupScript;
}

/**
 * Restore stored exec-config onto omitted keys of an incoming inventory document.
 * Present keys stay as-is so a capable PUT can change them without wiping omitted fields.
 */
export function preserveHostExecConfig(
  incoming: HostInventory,
  existing: HostInventory | null | undefined,
): HostInventory {
  const next: HostInventory = {
    ...incoming,
    repositories: incoming.repositories.map((repository) => ({
      ...repository,
      worktrees: repository.worktrees.map((worktree) => ({
        ...worktree,
        labels: [...worktree.labels],
      })),
    })),
    providerAccounts: incoming.providerAccounts.map((account) => ({ ...account })),
    capabilities: [...(incoming.capabilities ?? [])],
  };
  if (!Object.hasOwn(next, "setupScript")) restoreScript(next, existing ?? undefined);
  else if (next.setupScript === "") delete next.setupScript;
  if (next.allowedRoots === undefined) {
    if (existing?.allowedRoots !== undefined) next.allowedRoots = [...existing.allowedRoots];
    else delete next.allowedRoots;
  }
  for (const repository of next.repositories) {
    const previous = existing?.repositories.find((entry) => entry.id === repository.id);
    if (!Object.hasOwn(repository, "setupScript")) restoreScript(repository, previous);
    else if (repository.setupScript === "") delete repository.setupScript;
    if (!Object.hasOwn(repository, "terminalHookScript")) {
      if (previous?.terminalHookScript !== undefined) {
        repository.terminalHookScript = previous.terminalHookScript;
      } else {
        delete repository.terminalHookScript;
      }
    } else if (repository.terminalHookScript === "") {
      delete repository.terminalHookScript;
    }
    for (const worktree of repository.worktrees) {
      if (!Object.hasOwn(worktree, "setupScript")) {
        restoreScript(
          worktree,
          previous?.worktrees.find((entry) => entry.id === worktree.id),
        );
      } else if (worktree.setupScript === "") {
        delete worktree.setupScript;
      }
    }
  }
  return next;
}

export function reconcileInventoryWrite(input: {
  existing: HostInventory | null | undefined;
  incoming: HostInventory;
  allowExecConfig: boolean;
}):
  | { ok: true; inventory: HostInventory; execEdits: string[] }
  | { ok: false; error: string; execEdits: string[]; kind: "forbidden" | "validation" } {
  const existingDuplicateError = input.existing
    ? duplicateInventoryIdError(input.existing)
    : undefined;
  if (existingDuplicateError) {
    return {
      ok: false,
      error: `existing inventory: ${existingDuplicateError}`,
      execEdits: [],
      kind: "validation",
    };
  }
  const duplicateError = duplicateInventoryIdError(input.incoming);
  if (duplicateError) {
    return { ok: false, error: duplicateError, execEdits: [], kind: "validation" };
  }
  const inventory = preserveHostExecConfig(input.incoming, input.existing);
  const execEdits = listExecConfigEdits(input.existing, inventory);
  const legacyHookError = legacyRelativeHookError(input.existing, inventory);
  if (legacyHookError) {
    return { ok: false, error: legacyHookError, execEdits, kind: "validation" };
  }
  if (execEdits.length && !input.allowExecConfig) {
    return {
      ok: false,
      error: EXEC_CONFIG_REQUIRED_MESSAGE,
      execEdits,
      kind: "forbidden",
    };
  }
  return {
    ok: true,
    execEdits,
    inventory,
  };
}
