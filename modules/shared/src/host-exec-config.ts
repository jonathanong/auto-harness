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
    ...(existing.updateConfig !== undefined ? { updateConfig: { ...existing.updateConfig } } : {}),
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
  if (patch.updateConfig !== undefined) next.updateConfig = { ...patch.updateConfig };
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

function sameUpdateConfig(
  left: HostInventory["updateConfig"],
  right: HostInventory["updateConfig"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasSetupScript(value: string | undefined): boolean {
  return (value ?? "") !== "";
}

function hasTerminalHook(value: string | undefined): boolean {
  return (value ?? "") !== "";
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

function sameHookResolutionBases(previous: HostRepository, incoming: HostRepository): boolean {
  if (previous.path !== incoming.path) return false;
  const previousWorktrees = entriesById(previous.worktrees);
  const incomingWorktrees = entriesById(incoming.worktrees);
  if (previousWorktrees.size !== incomingWorktrees.size) return false;
  for (const [id, worktree] of incomingWorktrees) {
    if (previousWorktrees.get(id)?.path !== worktree.path) return false;
  }
  return true;
}

function isWindowsPath(path: string): boolean {
  return path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * The control plane accepts either platform's absolute spelling, but a host
 * executes paths using its own platform rules. Use the repository spelling as
 * the host hint so a foreign absolute-looking hook remains fenced like a
 * relative hook without rejecting inventories from the other platform.
 */
function isAbsoluteHookForRepository(hook: string, repositoryPath: string): boolean {
  if (!isAbsolutePathString(hook)) return false;
  if (isWindowsPath(hook) !== isWindowsPath(repositoryPath)) return false;
  return true;
}

/**
 * A relative hook is accepted only when a legacy document supplies the exact
 * same value. New or changed hooks must be absolute even for admins. Since a
 * relative hook is resolved from the execution repository/worktree, ordinary
 * inventory writes may not move either base without exec-config capability.
 */
function legacyRelativeHookError(
  existing: HostInventory | null | undefined,
  incoming: HostInventory,
  allowExecConfig: boolean,
): { error: string; kind: "forbidden" | "validation" } | undefined {
  const previousRepositories = entriesById(existing?.repositories);
  for (const repository of incoming.repositories) {
    const hook = repository.terminalHookScript;
    const previous = previousRepositories.get(repository.id);
    if (
      hook === undefined ||
      hook.length === 0 ||
      isAbsoluteHookForRepository(hook, previous?.path ?? repository.path)
    )
      continue;
    if (previous?.terminalHookScript === hook) {
      if (allowExecConfig || sameHookResolutionBases(previous, repository)) continue;
      return { error: EXEC_CONFIG_REQUIRED_MESSAGE, kind: "forbidden" };
    }
    return {
      error: `repository.${repository.id}.terminalHookScript must be an absolute path`,
      kind: "validation",
    };
  }
  return undefined;
}

/** True when deleting this inventory would erase admin-controlled executable paths. */
export function inventoryHasExecConfig(inventory: HostInventory | null | undefined): boolean {
  if (!inventory) return false;
  if (inventory.updateConfig !== undefined) return true;
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
  if (!sameUpdateConfig(existing?.updateConfig, incoming.updateConfig)) edits.push("updateConfig");

  const previousRepositories = entriesById(existing?.repositories);
  const incomingRepositories = entriesById(incoming.repositories);
  const hostSetupScript =
    hasSetupScript(existing?.setupScript) || hasSetupScript(incoming.setupScript);
  for (const repositoryId of idsInOrder(existing?.repositories, incoming.repositories)) {
    const previous = previousRepositories.get(repositoryId);
    const next = incomingRepositories.get(repositoryId);
    addOptionalStringEdit(
      edits,
      `repositories.${repositoryId}.setupScript`,
      previous?.setupScript,
      next?.setupScript,
    );
    // Setup scripts and terminal hooks execute in the claimed checkout. Moving
    // (or attaching) a repository can therefore change the executable context
    // for a main checkout even when the executable text itself is unchanged.
    const repositoryExecutionCwdIsTrusted =
      hostSetupScript ||
      hasSetupScript(previous?.setupScript) ||
      hasSetupScript(next?.setupScript) ||
      hasTerminalHook(previous?.terminalHookScript) ||
      hasTerminalHook(next?.terminalHookScript);
    if (
      next !== undefined &&
      (previous === undefined || !sameOptionalString(previous.path, next.path)) &&
      repositoryExecutionCwdIsTrusted
    ) {
      edits.push(`repositories.${repositoryId}.path`);
    }
    addOptionalStringEdit(
      edits,
      `repositories.${repositoryId}.terminalHookScript`,
      previous?.terminalHookScript,
      next?.terminalHookScript,
    );
    const previousWorktrees = entriesById(previous?.worktrees);
    const nextWorktrees = entriesById(next?.worktrees);
    for (const worktreeId of idsInOrder(previous?.worktrees, next?.worktrees)) {
      const previousWorktree = previousWorktrees.get(worktreeId);
      const nextWorktree = nextWorktrees.get(worktreeId);
      addOptionalStringEdit(
        edits,
        `repositories.${repositoryId}.worktrees.${worktreeId}.setupScript`,
        previousWorktree?.setupScript,
        nextWorktree?.setupScript,
      );
      // Setup scripts and terminal hooks run in this worktree's cwd, so its
      // path is executable configuration whenever either trusted action applies.
      const executionCwdIsTrusted =
        repositoryExecutionCwdIsTrusted ||
        hasSetupScript(previousWorktree?.setupScript) ||
        hasSetupScript(nextWorktree?.setupScript);
      if (
        executionCwdIsTrusted &&
        nextWorktree !== undefined &&
        (previousWorktree === undefined ||
          !sameOptionalString(previousWorktree.path, nextWorktree.path))
      ) {
        edits.push(`repositories.${repositoryId}.worktrees.${worktreeId}.path`);
      }
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
  if (!Object.hasOwn(next, "updateConfig")) {
    if (existing?.updateConfig !== undefined) next.updateConfig = { ...existing.updateConfig };
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
  const legacyHookError = legacyRelativeHookError(input.existing, inventory, input.allowExecConfig);
  if (legacyHookError) {
    return { ok: false, execEdits, ...legacyHookError };
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
