import { isValidSlugName, SLUG_NAME_HINT } from "@auto-harness/shared";

import type { ProviderRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import {
  getProviderDurable,
  listCommandsDurable,
  listProviderAccountsDurable,
  listProvidersDurable,
} from "./control-plane-durable-read-catalog.ts";
import {
  deleteConflict,
  dependenciesForProvider,
  referencesFromState,
  refreshDeleteReferences,
  type DeleteResult,
} from "./control-plane-delete-guards.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";
import { markersFor } from "./control-plane-delete-reference-markers.ts";

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
    queueWrite(state, state.storage.putProvider({ ...result.provider }));
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
    result.provider.defaultCommandId
      ? markersFor(state.now(), [`command:${result.provider.defaultCommandId}`])
      : [],
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
    queueWrite(state, state.storage.putProvider({ ...result.provider }));
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
    result.provider.defaultCommandId
      ? markersFor(state.now(), [`command:${result.provider.defaultCommandId}`])
      : [],
  );
  state.providers.set(id, result.provider);
  return { ok: true, provider: { ...result.provider } };
}

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
  if (!state.providers.has(id)) {
    return { ok: false, error: "provider not found" };
  }
  return deleteConflict("provider", dependenciesForProvider(refs, id));
}
