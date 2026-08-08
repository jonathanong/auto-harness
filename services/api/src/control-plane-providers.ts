import { isValidSlugName, SLUG_NAME_HINT } from "@auto-harness/shared";

import type { ProviderRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

function findProviderByName(
  state: ControlPlaneState,
  name: string,
  excludeId?: string,
): ProviderRecord | undefined {
  for (const p of state.providers.values()) {
    if (p.name === name && p.id !== excludeId) {
      return p;
    }
  }
  return undefined;
}

export function createProvider(
  state: ControlPlaneState,
  input: { id?: string; name: string; defaultCommandId?: string | null },
): { ok: true; provider: ProviderRecord } | { ok: false; error: string } {
  if (!input.name) {
    return { ok: false, error: "name is required" };
  }
  if (!isValidSlugName(input.name)) {
    return { ok: false, error: `name must be ${SLUG_NAME_HINT}` };
  }
  if (findProviderByName(state, input.name)) {
    return { ok: false, error: `provider name already in use: ${input.name}` };
  }
  const id = input.id ?? state.providerIdFactory();
  if (state.providers.has(id)) {
    return { ok: false, error: `provider already exists: ${id}` };
  }
  const at = state.now();
  const rec: ProviderRecord = {
    id,
    name: input.name,
    defaultCommandId: input.defaultCommandId ?? null,
    createdAt: at,
    updatedAt: at,
  };
  state.providers.set(id, rec);
  if (state.storage) {
    queueWrite(state, state.storage.putProvider({ ...rec }));
  }
  return { ok: true, provider: { ...rec } };
}

export function getProvider(state: ControlPlaneState, id: string): ProviderRecord | null {
  const p = state.providers.get(id);
  return p ? { ...p } : null;
}

export function listProviders(state: ControlPlaneState): ProviderRecord[] {
  return [...state.providers.values()]
    .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((p) => ({ ...p }));
}

export function updateProvider(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{ name: string; defaultCommandId: string | null }>,
): { ok: true; provider: ProviderRecord } | { ok: false; error: string } {
  const existing = state.providers.get(id);
  if (!existing) {
    return { ok: false, error: "provider not found" };
  }
  if (patch.name !== undefined) {
    if (!isValidSlugName(patch.name)) {
      return { ok: false, error: `name must be ${SLUG_NAME_HINT}` };
    }
    if (findProviderByName(state, patch.name, id)) {
      return { ok: false, error: `provider name already in use: ${patch.name}` };
    }
  }
  const next: ProviderRecord = {
    ...existing,
    updatedAt: state.now(),
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.defaultCommandId !== undefined ? { defaultCommandId: patch.defaultCommandId } : {}),
  };
  state.providers.set(id, next);
  if (state.storage) {
    queueWrite(state, state.storage.putProvider({ ...next }));
  }
  return { ok: true, provider: { ...next } };
}

export function deleteProvider(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.providers.has(id)) {
    return { ok: false, error: "provider not found" };
  }
  for (const a of state.providerAccounts.values()) {
    if (a.providerId === id) {
      return { ok: false, error: "provider has attached accounts — remove them first" };
    }
  }
  for (const c of state.commands.values()) {
    if (c.providerId === id) {
      return { ok: false, error: "provider has commands — remove or reassign them first" };
    }
  }
  state.providers.delete(id);
  if (state.storage) {
    queueWrite(state, state.storage.deleteProvider(id));
  }
  return { ok: true };
}
