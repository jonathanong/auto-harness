import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import {
  deleteConflict,
  dependenciesForRepository,
  referencesFromState,
  refreshDeleteReferences,
  type DeleteResult,
} from "./control-plane-delete-guards.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";

export function deleteRepository(state: ControlPlaneState, id: string): DeleteResult {
  const result = canDeleteRepository(state, id, referencesFromState(state));
  if (!result.ok) return result;
  state.repositories.delete(id);
  if (state.storage) queueWrite(state, state.storage.deleteRepository(id));
  return { ok: true };
}

export async function deleteRepositoryDurable(
  state: ControlPlaneState,
  id: string,
): Promise<ReturnType<typeof deleteRepository>> {
  if (!state.storage) return deleteRepository(state, id);
  if (!state.repositories.has(id)) return { ok: false, error: "repository not found" };
  return withDeletionMarkers(state, [`repository:${id}`], async (owner) => {
    const result = canDeleteRepository(state, id, await refreshDeleteReferences(state));
    if (!result.ok) return result;
    await state.storage!.deleteRepository(id, [
      { key: `repository:${id}`, owner, now: state.now() },
    ]);
    state.repositories.delete(id);
    return { ok: true };
  });
}

function canDeleteRepository(
  state: ControlPlaneState,
  id: string,
  refs = referencesFromState(state),
): DeleteResult {
  if (!state.repositories.has(id)) return { ok: false, error: "repository not found" };
  return deleteConflict("repository", dependenciesForRepository(refs, id));
}
