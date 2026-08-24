import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import {
  EXEC_CONFIG_REQUIRED_MESSAGE,
  type HostExecConfigPatch,
} from "./host-exec-config-parse.ts";

export {
  MAX_ALLOWED_ROOTS,
  MAX_EXEC_PATH_LENGTH,
  isAbsolutePathString,
  parseAllowedRoots,
  parseHostExecConfig,
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

/**
 * Field paths the incoming inventory document would change. Omitted keys are not edits;
 * they are preserved by ordinary inventory writes.
 */
export function listExecConfigEdits(
  existing: HostInventory | null | undefined,
  incoming: HostInventory,
): string[] {
  const edits: string[] = [];
  if (
    incoming.setupScript !== undefined &&
    !sameOptionalString(incoming.setupScript, existing?.setupScript)
  ) {
    edits.push("setupScript");
  }
  if (
    incoming.allowedRoots !== undefined &&
    !sameRoots(incoming.allowedRoots, existing?.allowedRoots)
  ) {
    edits.push("allowedRoots");
  }
  for (const repository of incoming.repositories) {
    const previous = existing?.repositories.find((entry) => entry.id === repository.id);
    if (
      repository.setupScript !== undefined &&
      !sameOptionalString(repository.setupScript, previous?.setupScript)
    ) {
      edits.push(`repositories.${repository.id}.setupScript`);
    }
    if (
      repository.terminalHookScript !== undefined &&
      !sameOptionalString(repository.terminalHookScript, previous?.terminalHookScript)
    ) {
      edits.push(`repositories.${repository.id}.terminalHookScript`);
    }
    for (const worktree of repository.worktrees) {
      const previousWorktree = previous?.worktrees.find((entry) => entry.id === worktree.id);
      if (
        worktree.setupScript !== undefined &&
        !sameOptionalString(worktree.setupScript, previousWorktree?.setupScript)
      ) {
        edits.push(`repositories.${repository.id}.worktrees.${worktree.id}.setupScript`);
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

/** Copy stored exec-config onto an incoming inventory document so a maintainer PUT cannot wipe it. */
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
  restoreScript(next, existing ?? undefined);
  if (existing?.allowedRoots?.length) next.allowedRoots = [...existing.allowedRoots];
  else delete next.allowedRoots;
  for (const repository of next.repositories) {
    const previous = existing?.repositories.find((entry) => entry.id === repository.id);
    restoreScript(repository, previous);
    if (previous?.terminalHookScript !== undefined) {
      repository.terminalHookScript = previous.terminalHookScript;
    } else {
      delete repository.terminalHookScript;
    }
    for (const worktree of repository.worktrees) {
      restoreScript(
        worktree,
        previous?.worktrees.find((entry) => entry.id === worktree.id),
      );
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
  | { ok: false; error: string; execEdits: string[] } {
  const execEdits = listExecConfigEdits(input.existing, input.incoming);
  if (execEdits.length && !input.allowExecConfig) {
    return { ok: false, error: EXEC_CONFIG_REQUIRED_MESSAGE, execEdits };
  }
  return {
    ok: true,
    execEdits,
    inventory: input.allowExecConfig
      ? input.incoming
      : preserveHostExecConfig(input.incoming, input.existing),
  };
}
