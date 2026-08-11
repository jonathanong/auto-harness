import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import {
  getProviderDurable,
  listCommandsDurable,
  listProviderAccountsDurable,
} from "./control-plane-durable-read-catalog.ts";
import {
  deleteConflict,
  dependenciesForProvider,
  referencesFromState,
  refreshDeleteReferences,
  type DeleteResult,
} from "./control-plane-delete-guards.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";

export function deleteProvider(state: ControlPlaneState, id: string): DeleteResult {
  const result = canDeleteProvider(state, id, referencesFromState(state));
  if (!result.ok) return result;
  state.providers.delete(id);
  if (state.storage) {
    queueWrite(
      state,
      state.storage.deleteProvider(id).then(async (deleted) => {
        if (deleted) return;
        const authoritative = await state.storage?.getProvider(id);
        if (authoritative) state.providers.set(id, authoritative);
      }),
    );
  }
  return { ok: true };
}

/** Delete durable state before dropping the cached provider. */
export async function deleteProviderDurable(
  state: ControlPlaneState,
  id: string,
): Promise<ReturnType<typeof deleteProvider>> {
  if (!state.storage) return deleteProvider(state, id);
  await Promise.all([
    getProviderDurable(state, id),
    listProviderAccountsDurable(state),
    listCommandsDurable(state),
  ]);
  if (!state.providers.has(id)) return { ok: false, error: "provider not found" };
  return withDeletionMarkers(state, [`provider:${id}`], async (owner) => {
    const result = canDeleteProvider(state, id, await refreshDeleteReferences(state));
    if (!result.ok) return result;
    if (
      !(await state.storage!.deleteProvider(id, [
        { key: `provider:${id}`, owner, now: state.now() },
      ]))
    ) {
      const authoritative = await state.storage!.getProvider(id);
      if (authoritative) state.providers.set(id, authoritative);
      return { ok: false, error: "provider changed concurrently", conflict: true };
    }
    state.providers.delete(id);
    return { ok: true };
  });
}

function canDeleteProvider(
  state: ControlPlaneState,
  id: string,
  refs = referencesFromState(state),
): DeleteResult {
  if (!state.providers.has(id)) return { ok: false, error: "provider not found" };
  return deleteConflict("provider", dependenciesForProvider(refs, id));
}
