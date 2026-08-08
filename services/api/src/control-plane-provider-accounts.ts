import type { ProviderAccountRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

export function createProviderAccount(
  state: ControlPlaneState,
  input: { id?: string; providerId: string; label: string },
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  if (!input.providerId || !input.label) {
    return { ok: false, error: "providerId and label are required" };
  }
  if (!state.providers.has(input.providerId)) {
    return { ok: false, error: `unknown provider: ${input.providerId}` };
  }
  const id = input.id ?? state.providerAccountIdFactory();
  if (state.providerAccounts.has(id)) {
    return { ok: false, error: `provider account already exists: ${id}` };
  }
  const at = state.now();
  const rec: ProviderAccountRecord = {
    id,
    providerId: input.providerId,
    label: input.label,
    createdAt: at,
    updatedAt: at,
  };
  state.providerAccounts.set(id, rec);
  if (state.storage) {
    queueWrite(state, state.storage.putProviderAccount({ ...rec }));
  }
  return { ok: true, account: { ...rec } };
}

export function getProviderAccount(
  state: ControlPlaneState,
  id: string,
): ProviderAccountRecord | null {
  const a = state.providerAccounts.get(id);
  return a ? { ...a } : null;
}

export function listProviderAccounts(state: ControlPlaneState): ProviderAccountRecord[] {
  return [...state.providerAccounts.values()]
    .toSorted((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .map((a) => ({ ...a }));
}

export function updateProviderAccount(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{ providerId: string; label: string }>,
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  const existing = state.providerAccounts.get(id);
  if (!existing) {
    return { ok: false, error: "provider account not found" };
  }
  if (patch.providerId !== undefined && !state.providers.has(patch.providerId)) {
    return { ok: false, error: `unknown provider: ${patch.providerId}` };
  }
  const next: ProviderAccountRecord = {
    ...existing,
    updatedAt: state.now(),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
  };
  state.providerAccounts.set(id, next);
  if (state.storage) {
    queueWrite(state, state.storage.putProviderAccount({ ...next }));
  }
  return { ok: true, account: { ...next } };
}

export function deleteProviderAccount(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.providerAccounts.has(id)) {
    return { ok: false, error: "provider account not found" };
  }
  state.providerAccounts.delete(id);
  if (state.storage) {
    queueWrite(state, state.storage.deleteProviderAccount(id));
  }
  return { ok: true };
}
