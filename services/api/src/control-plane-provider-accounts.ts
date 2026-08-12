import type { ProviderAccountRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import {
  prepareCreateProviderAccount,
  prepareUpdateProviderAccount,
} from "./control-plane-provider-accounts-prepare.ts";
import {
  deleteConflict,
  dependenciesForAccount,
  referencesFromState,
  type DeleteResult,
} from "./control-plane-delete-guards.ts";

export function createProviderAccount(
  state: ControlPlaneState,
  input: { id?: string; providerId: string; label: string; usageLimitCooldownSeconds?: number },
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  const result = prepareCreateProviderAccount(state, input);
  if (!result.ok) return result;
  state.providerAccounts.set(result.account.id, result.account);
  if (state.storage) {
    queueWrite(state, (storage) => storage!.putProviderAccount({ ...result.account }));
  }
  return { ok: true, account: { ...result.account } };
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
  patch: Partial<{ providerId: string; label: string; usageLimitCooldownSeconds: number }>,
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  const result = prepareUpdateProviderAccount(state, id, patch);
  if (!result.ok) return result;
  state.providerAccounts.set(id, result.account);
  if (state.storage) {
    queueWrite(state, (storage) =>
      storage!
        .updateProviderAccount({
          id,
          expectedVersion: result.existing.version ?? 0,
          expectedProviderId: result.existing.providerId,
          updatedAt: result.account.updatedAt,
          patch: result.patch,
        })
        .then(async (updated) => {
          if (updated) return;
          const authoritative = await storage?.getProviderAccount(id);
          if (authoritative) state.providerAccounts.set(id, authoritative);
          else state.providerAccounts.delete(id);
        }),
    );
  }
  return { ok: true, account: { ...result.account } };
}

/** Clear a global vendor pause. The caller is responsible for running assignment afterwards. */
export function clearProviderAccountUsageLimit(
  state: ControlPlaneState,
  id: string,
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  const existing = state.providerAccounts.get(id);
  if (!existing) return { ok: false, error: "provider account not found" };
  const account = {
    ...existing,
    usageLimitedUntil: null,
    updatedAt: state.now(),
  };
  const expectedVersion = existing.version === undefined ? 0 : existing.version;
  state.providerAccounts.set(id, account);
  if (state.storage) {
    queueWrite(state, (storage) =>
      storage!
        .clearProviderAccountUsageLimit({
          id,
          expectedVersion,
          ...(existing.usageLimitedUntil !== undefined
            ? { expectedUsageLimitedUntil: existing.usageLimitedUntil }
            : {}),
          updatedAt: account.updatedAt,
        })
        .then(() => undefined),
    );
  }
  return { ok: true, account: { ...account } };
}

/** Clear a cooldown against the authoritative row and surface a lost compare-and-swap. */
export async function clearProviderAccountUsageLimitDurable(
  state: ControlPlaneState,
  id: string,
): Promise<
  { ok: true; account: ProviderAccountRecord } | { ok: false; error: string; conflict?: boolean }
> {
  if (!state.storage) return clearProviderAccountUsageLimit(state, id);
  const existing = await state.storage.getProviderAccount(id);
  if (!existing) {
    state.providerAccounts.delete(id);
    return { ok: false, error: "provider account not found" };
  }
  const account = {
    ...existing,
    usageLimitedUntil: null,
    updatedAt: state.now(),
    version: (existing.version ?? 0) + 1,
  };
  const cleared = await state.storage.clearProviderAccountUsageLimit({
    id,
    expectedVersion: existing.version ?? 0,
    ...(existing.usageLimitedUntil !== undefined
      ? { expectedUsageLimitedUntil: existing.usageLimitedUntil }
      : {}),
    updatedAt: account.updatedAt,
  });
  if (!cleared) {
    const authoritative = await state.storage.getProviderAccount(id);
    if (authoritative) state.providerAccounts.set(id, authoritative);
    else state.providerAccounts.delete(id);
    return {
      ok: false,
      error: authoritative
        ? "provider account changed concurrently; retry cooldown clear"
        : "provider account not found",
      ...(authoritative ? { conflict: true } : {}),
    };
  }
  state.providerAccounts.set(id, account);
  return { ok: true, account: { ...account } };
}

export function deleteProviderAccount(state: ControlPlaneState, id: string): DeleteResult {
  if (!state.providerAccounts.has(id)) {
    return { ok: false, error: "provider account not found" };
  }
  const result = deleteConflict(
    "provider account",
    dependenciesForAccount(referencesFromState(state), id),
  );
  if (!result.ok) return result;
  state.providerAccounts.delete(id);
  if (state.storage) {
    queueWrite(state, (storage) => storage!.deleteProviderAccount(id));
  }
  return { ok: true };
}
