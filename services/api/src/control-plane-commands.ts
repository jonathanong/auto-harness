import type { CommandRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

function isValidArgv(argv: unknown): argv is string[] {
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((a) => typeof a === "string" && a.length > 0)
  );
}

export type CommandInput = {
  id?: string;
  name: string;
  argv: string[];
  appendPrompt?: boolean;
  /** Soft FK — the UI filters/suggests by it; a mismatched value is never hard-blocked. */
  providerId?: string | null;
};

export function createCommand(
  state: ControlPlaneState,
  input: CommandInput,
): { ok: true; command: CommandRecord } | { ok: false; error: string } {
  if (!input.name) {
    return { ok: false, error: "name is required" };
  }
  if (!isValidArgv(input.argv)) {
    return { ok: false, error: "argv must be a non-empty array of non-empty strings" };
  }
  const id = input.id ?? state.commandIdFactory();
  if (state.commands.has(id)) {
    return { ok: false, error: `command already exists: ${id}` };
  }
  const at = state.now();
  const rec: CommandRecord = {
    id,
    name: input.name,
    argv: input.argv,
    appendPrompt: input.appendPrompt !== false,
    providerId: input.providerId ?? null,
    createdAt: at,
    updatedAt: at,
  };
  state.commands.set(id, rec);
  if (state.storage) {
    queueWrite(state, state.storage.putCommand({ ...rec }));
  }
  return { ok: true, command: { ...rec } };
}

export function getCommand(state: ControlPlaneState, id: string): CommandRecord | null {
  const c = state.commands.get(id);
  return c ? { ...c } : null;
}

export function listCommands(state: ControlPlaneState): CommandRecord[] {
  return [...state.commands.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((c) => ({ ...c }));
}

export function updateCommand(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{
    name: string;
    argv: string[];
    appendPrompt: boolean;
    providerId: string | null;
  }>,
): { ok: true; command: CommandRecord } | { ok: false; error: string } {
  const existing = state.commands.get(id);
  if (!existing) {
    return { ok: false, error: "command not found" };
  }
  if (patch.argv !== undefined && !isValidArgv(patch.argv)) {
    return { ok: false, error: "argv must be a non-empty array of non-empty strings" };
  }
  const next: CommandRecord = {
    ...existing,
    updatedAt: state.now(),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.argv !== undefined ? { argv: patch.argv } : {}),
    ...(patch.appendPrompt !== undefined ? { appendPrompt: patch.appendPrompt } : {}),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
  };
  state.commands.set(id, next);
  if (state.storage) {
    queueWrite(state, state.storage.putCommand({ ...next }));
  }
  return { ok: true, command: { ...next } };
}

export function deleteCommand(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.commands.has(id)) {
    return { ok: false, error: "command not found" };
  }
  for (const p of state.providers.values()) {
    if (p.defaultCommandId === id) {
      return { ok: false, error: "command is a provider's default command" };
    }
  }
  state.commands.delete(id);
  if (state.storage) {
    queueWrite(state, state.storage.deleteCommand(id));
  }
  return { ok: true };
}
