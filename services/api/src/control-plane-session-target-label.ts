import type { TargetRef } from "@auto-harness/shared";

import type { ControlPlaneState } from "./control-plane-state.ts";

/** Validate catalog targets at create/update time and produce display labels. */
export function resolveSessionTargetLabel(
  state: ControlPlaneState,
  target: TargetRef,
): { ok: true; label: string } | { ok: false; error: string } {
  if ("providerId" in target) {
    const provider = state.providers.get(target.providerId);
    return provider
      ? { ok: true, label: provider.name }
      : { ok: false, error: `providerId ${target.providerId} not found` };
  }
  const command = state.commands.get(target.commandId);
  if (!command) return { ok: false, error: `commandId ${target.commandId} not found` };
  const provider = command.providerId === null ? null : state.providers.get(command.providerId);
  if (command.providerId !== null && !provider) {
    return { ok: false, error: `provider ${command.providerId} not found` };
  }
  return { ok: true, label: provider ? `${provider.name} — ${command.name}` : command.name };
}

export function resolveTargetLabels(
  state: ControlPlaneState,
  target: TargetRef,
  fallbacks: TargetRef[],
): { ok: true; labels: string[] } | { ok: false; error: string } {
  const labels: string[] = [];
  for (const item of [target, ...fallbacks]) {
    const result = resolveSessionTargetLabel(state, item);
    if (!result.ok) return result;
    labels.push(result.label);
  }
  return { ok: true, labels };
}
