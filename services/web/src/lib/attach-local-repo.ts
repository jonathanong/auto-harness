import { mutateInventory, upsertHostRepository } from "@auto-harness/shared";

/**
 * Attach an existing catalog repository's local path to a host.
 * Does not invent worktrees — add those on the agent host config UI.
 * Uses mutateInventory so a concurrent worktree edit cannot be clobbered.
 */
export async function attachLocalRepo(input: {
  hostId: string;
  id: string;
  path: string;
  defaultBranch: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return mutateInventory(input.hostId, (existing) =>
    upsertHostRepository(existing, {
      id: input.id,
      path: input.path,
      defaultBranch: input.defaultBranch,
    }),
  );
}
