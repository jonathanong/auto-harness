import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import {
  deleteConflict,
  dependenciesForCommand,
  referencesFromState,
  refreshDeleteReferences,
  type DeleteResult,
} from "./control-plane-delete-guards.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";
import { getCommandDurable } from "./control-plane-durable-read-catalog.ts";

export function deleteCommand(state: ControlPlaneState, id: string): DeleteResult {
  const result = canDeleteCommand(state, id, referencesFromState(state));
  if (!result.ok) return result;
  state.commands.delete(id);
  if (state.storage) queueWrite(state, (storage) => storage!.deleteCommand(id));
  return { ok: true };
}

export async function deleteCommandDurable(
  state: ControlPlaneState,
  id: string,
): Promise<ReturnType<typeof deleteCommand>> {
  if (!state.storage) return deleteCommand(state, id);
  await getCommandDurable(state, id);
  if (!state.commands.has(id)) return { ok: false, error: "command not found" };
  return withDeletionMarkers(state, [`command:${id}`], async (owner) => {
    const result = canDeleteCommand(state, id, await refreshDeleteReferences(state));
    if (!result.ok) return result;
    await state.storage!.deleteCommand(id, [{ key: `command:${id}`, owner, now: state.now() }]);
    state.commands.delete(id);
    return { ok: true };
  });
}

function canDeleteCommand(
  state: ControlPlaneState,
  id: string,
  refs = referencesFromState(state),
): DeleteResult {
  if (!state.commands.has(id)) return { ok: false, error: "command not found" };
  return deleteConflict("command", dependenciesForCommand(refs, id));
}
