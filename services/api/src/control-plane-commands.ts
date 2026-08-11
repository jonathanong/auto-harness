import type { CommandRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { markersFor } from "./control-plane-delete-reference-markers.ts";
import {
  validateCommandArgv,
  validateCommandResumeSpec,
  type ResumeRefCapture,
} from "@auto-harness/shared";
import { getCommandDurable } from "./control-plane-durable-read-catalog.ts";

export type CommandInput = {
  id?: string;
  name: string;
  argv: string[];
  appendPrompt?: boolean;
  resumeArgvTemplate?: string[] | null;
  resumeRefCapture?: ResumeRefCapture | null;
  /** Soft FK — the UI filters/suggests by it; a mismatched value is never hard-blocked. */
  providerId?: string | null;
};

export function createCommand(
  state: ControlPlaneState,
  input: CommandInput,
): { ok: true; command: CommandRecord } | { ok: false; error: string } {
  const result = prepareCreateCommand(state, input);
  if (!result.ok) return result;
  state.commands.set(result.command.id, result.command);
  if (state.storage) {
    queueWrite(state, state.storage.putCommand({ ...result.command }));
  }
  return { ok: true, command: { ...result.command } };
}

function prepareCreateCommand(
  state: ControlPlaneState,
  input: CommandInput,
): { ok: true; command: CommandRecord } | { ok: false; error: string } {
  if (!input.name) {
    return { ok: false, error: "name is required" };
  }
  const argv = validateCommandArgv(input.argv);
  if (!argv.ok) {
    return { ok: false, error: argv.error };
  }
  const resume = validateCommandResumeSpec(input);
  if (!resume.ok) {
    return resume;
  }
  const id = input.id ?? state.commandIdFactory();
  if (state.commands.has(id)) {
    return { ok: false, error: `command already exists: ${id}` };
  }
  const at = state.now();
  const rec: CommandRecord = {
    id,
    name: input.name,
    argv: argv.value,
    appendPrompt: input.appendPrompt !== false,
    ...resume.value,
    providerId: input.providerId ?? null,
    createdAt: at,
    updatedAt: at,
  };
  return { ok: true, command: rec };
}

/** Persist a command before exposing it through the process cache. */
export async function createCommandDurable(
  state: ControlPlaneState,
  input: CommandInput,
): Promise<ReturnType<typeof createCommand>> {
  if (!state.storage) return createCommand(state, input);
  if (input.id) await getCommandDurable(state, input.id);
  const result = prepareCreateCommand(state, input);
  if (!result.ok) return result;
  await state.storage.putCommand(
    { ...result.command },
    markersFor(state.now(), [
      `command:${result.command.id}`,
      ...(result.command.providerId ? [`provider:${result.command.providerId}`] : []),
    ]),
  );
  state.commands.set(result.command.id, result.command);
  return { ok: true, command: { ...result.command } };
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
    resumeArgvTemplate: string[] | null;
    resumeRefCapture: ResumeRefCapture | null;
  }>,
): { ok: true; command: CommandRecord } | { ok: false; error: string } {
  const result = prepareUpdateCommand(state, id, patch);
  if (!result.ok) return result;
  state.commands.set(id, result.command);
  if (state.storage) {
    queueWrite(state, state.storage.putCommand({ ...result.command }));
  }
  return { ok: true, command: { ...result.command } };
}

function prepareUpdateCommand(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{
    name: string;
    argv: string[];
    appendPrompt: boolean;
    providerId: string | null;
    resumeArgvTemplate: string[] | null;
    resumeRefCapture: ResumeRefCapture | null;
  }>,
): { ok: true; command: CommandRecord } | { ok: false; error: string } {
  const existing = state.commands.get(id);
  if (!existing) {
    return { ok: false, error: "command not found" };
  }
  if (patch.argv !== undefined) {
    const argv = validateCommandArgv(patch.argv);
    if (!argv.ok) return { ok: false, error: argv.error };
  }
  const resume = validateCommandResumeSpec(patch);
  if (!resume.ok) return resume;
  const next: CommandRecord = {
    ...existing,
    updatedAt: state.now(),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.argv !== undefined ? { argv: patch.argv } : {}),
    ...(patch.appendPrompt !== undefined ? { appendPrompt: patch.appendPrompt } : {}),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.resumeArgvTemplate !== undefined && patch.resumeArgvTemplate !== null
      ? { resumeArgvTemplate: resume.value.resumeArgvTemplate }
      : {}),
    ...(patch.resumeRefCapture !== undefined && patch.resumeRefCapture !== null
      ? { resumeRefCapture: resume.value.resumeRefCapture }
      : {}),
  };
  if (patch.resumeArgvTemplate === null) delete next.resumeArgvTemplate;
  if (patch.resumeRefCapture === null) delete next.resumeRefCapture;
  return { ok: true, command: next };
}

/** Persist a command update before replacing the cache entry. */
export async function updateCommandDurable(
  state: ControlPlaneState,
  id: string,
  patch: Parameters<typeof updateCommand>[2],
): Promise<ReturnType<typeof updateCommand>> {
  if (!state.storage) return updateCommand(state, id, patch);
  await getCommandDurable(state, id);
  const result = prepareUpdateCommand(state, id, patch);
  if (!result.ok) return result;
  await state.storage.putCommand(
    { ...result.command },
    markersFor(state.now(), [
      `command:${id}`,
      ...(result.command.providerId ? [`provider:${result.command.providerId}`] : []),
    ]),
  );
  state.commands.set(id, result.command);
  return { ok: true, command: { ...result.command } };
}
