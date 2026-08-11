import type { ControlPlaneState } from "./control-plane-state.ts";
import { canDeleteCommand, deleteCommand } from "./control-plane-commands.ts";
import { getCommandDurable, listProvidersDurable } from "./control-plane-durable-read-catalog.ts";

/** Delete a command after refreshing the rows that constrain its removal. */
export async function deleteCommandDurable(
  state: ControlPlaneState,
  id: string,
): Promise<ReturnType<typeof deleteCommand>> {
  if (!state.storage) return deleteCommand(state, id);
  await getCommandDurable(state, id);
  await listProvidersDurable(state);
  const result = canDeleteCommand(state, id);
  if (!result.ok) return result;
  await state.storage.deleteCommand(id);
  state.commands.delete(id);
  return { ok: true };
}
