import { isValidSlugName, SLUG_NAME_HINT } from "@auto-harness/shared";

import type { ProviderRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { listProvidersDurable } from "./control-plane-durable-read-catalog.ts";
import { markersFor } from "./control-plane-delete-reference-markers.ts";

export { deleteProvider, deleteProviderDurable } from "./control-plane-provider-delete.ts";

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
  const result = prepareCreateProvider(state, input);
  if (!result.ok) return result;
  state.providers.set(result.provider.id, result.provider);
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putProvider({ ...result.provider }));
  }
  return { ok: true, provider: { ...result.provider } };
}

function prepareCreateProvider(
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
  return { ok: true, provider: rec };
}

/** Persist a provider before exposing it through the process cache. */
export async function createProviderDurable(
  state: ControlPlaneState,
  input: Parameters<typeof createProvider>[1],
): Promise<ReturnType<typeof createProvider>> {
  if (!state.storage) return createProvider(state, input);
  await listProvidersDurable(state);
  const result = prepareCreateProvider(state, input);
  if (!result.ok) return result;
  await state.storage.putProvider(
    { ...result.provider },
    markersFor(state.now(), [
      `provider:${result.provider.id}`,
      ...(result.provider.defaultCommandId ? [`command:${result.provider.defaultCommandId}`] : []),
    ]),
  );
  state.providers.set(result.provider.id, result.provider);
  return { ok: true, provider: { ...result.provider } };
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
  const result = prepareUpdateProvider(state, id, patch);
  if (!result.ok) return result;
  state.providers.set(id, result.provider);
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putProvider({ ...result.provider }));
  }
  return { ok: true, provider: { ...result.provider } };
}

function prepareUpdateProvider(
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
  return { ok: true, provider: next };
}

/** Persist a provider update before replacing the cache entry. */
export async function updateProviderDurable(
  state: ControlPlaneState,
  id: string,
  patch: Parameters<typeof updateProvider>[2],
): Promise<ReturnType<typeof updateProvider>> {
  if (!state.storage) return updateProvider(state, id, patch);
  await listProvidersDurable(state);
  const result = prepareUpdateProvider(state, id, patch);
  if (!result.ok) return result;
  await state.storage.putProvider(
    { ...result.provider },
    markersFor(state.now(), [
      `provider:${id}`,
      ...(result.provider.defaultCommandId ? [`command:${result.provider.defaultCommandId}`] : []),
    ]),
  );
  state.providers.set(id, result.provider);
  return { ok: true, provider: { ...result.provider } };
}
