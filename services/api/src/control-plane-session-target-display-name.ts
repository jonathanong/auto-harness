import type { TargetRef } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";

/** Validate catalog targets at create/update time and produce display names. */
export function resolveSessionTargetDisplayName(
  state: ControlPlaneState,
  target: TargetRef,
): { ok: true; displayName: string } | { ok: false; error: string } {
  if ("providerId" in target) {
    const provider = state.providers.get(target.providerId);
    return provider
      ? { ok: true, displayName: provider.name }
      : { ok: false, error: `providerId ${target.providerId} not found` };
  }
  const command = state.commands.get(target.commandId);
  if (!command) return { ok: false, error: `commandId ${target.commandId} not found` };
  const provider = command.providerId === null ? null : state.providers.get(command.providerId);
  if (command.providerId !== null && !provider) {
    return { ok: false, error: `provider ${command.providerId} not found` };
  }
  return {
    ok: true,
    displayName: provider ? `${provider.name} — ${command.name}` : command.name,
  };
}

export function resolveTargetDisplayNames(
  state: ControlPlaneState,
  target: TargetRef,
  fallbacks: TargetRef[],
): { ok: true; displayNames: string[] } | { ok: false; error: string } {
  const displayNames: string[] = [];
  for (const item of [target, ...fallbacks]) {
    const result = resolveSessionTargetDisplayName(state, item);
    if (!result.ok) return result;
    displayNames.push(result.displayName);
  }
  return { ok: true, displayNames };
}
