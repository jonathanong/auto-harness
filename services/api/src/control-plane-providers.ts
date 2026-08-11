/* eslint-disable max-lines */
import {
  isValidSlugName,
  SLUG_NAME_HINT,
  validateUsageRates,
  type UsageRates,
} from "@auto-harness/shared";

import type { ProviderRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import {
  getProviderDurable,
  listCommandsDurable,
  listProviderAccountsDurable,
  listProvidersDurable,
} from "./control-plane-durable-read-catalog.ts";

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
  input: { id?: string; name: string; defaultCommandId?: string | null; usageRates?: UsageRates },
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
  input: { id?: string; name: string; defaultCommandId?: string | null; usageRates?: UsageRates },
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
    ...(input.usageRates ? { usageRates: input.usageRates } : {}),
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
  await state.storage.putProvider({ ...result.provider });
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
  patch: Partial<{ name: string; defaultCommandId: string | null; usageRates: UsageRates | null }>,
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
  patch: Partial<{ name: string; defaultCommandId: string | null; usageRates: UsageRates | null }>,
): { ok: true; provider: ProviderRecord } | { ok: false; error: string } {
  const existing = state.providers.get(id);
  if (!existing) {
    return { ok: false, error: "provider not found" };
  }
  if (
    patch.usageRates !== undefined &&
    patch.usageRates !== null &&
    !validateUsageRates(patch.usageRates)
  ) {
    return {
      ok: false,
      error: "usageRates must contain uppercase ISO currency and non-negative micros",
    };
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
    ...(patch.usageRates !== undefined && patch.usageRates !== null
      ? { usageRates: patch.usageRates }
      : {}),
  };
  if (patch.usageRates === null) delete next.usageRates;
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
  await state.storage.putProvider({ ...result.provider });
  state.providers.set(id, result.provider);
  return { ok: true, provider: { ...result.provider } };
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
  const result = canDeleteProvider(state, id);
  if (!result.ok) return result;
  await state.storage.deleteProvider(id);
  state.providers.delete(id);
  return { ok: true };
}

function canDeleteProvider(
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
  return { ok: true };
}
