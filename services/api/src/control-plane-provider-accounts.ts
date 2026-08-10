import type { ProviderAccountRecord } from "./db/plane-storage.ts";
import { DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS } from "@auto-harness/shared";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

export function createProviderAccount(
  state: ControlPlaneState,
  input: { id?: string; providerId: string; label: string; usageLimitCooldownSeconds?: number },
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  if (!input.providerId || !input.label) {
    return { ok: false, error: "providerId and label are required" };
  }
  if (!state.providers.has(input.providerId)) {
    return { ok: false, error: `unknown provider: ${input.providerId}` };
  }
  if (
    input.usageLimitCooldownSeconds !== undefined &&
    (!Number.isInteger(input.usageLimitCooldownSeconds) || input.usageLimitCooldownSeconds <= 0)
  ) {
    return { ok: false, error: "usageLimitCooldownSeconds must be a positive integer" };
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
    usageLimitCooldownSeconds:
      input.usageLimitCooldownSeconds ?? DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS,
    usageLimitedUntil: null,
    lastUsageLimitedAt: null,
    lastAssignedAt: null,
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
  patch: Partial<{ providerId: string; label: string; usageLimitCooldownSeconds: number }>,
): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
  const existing = state.providerAccounts.get(id);
  if (!existing) {
    return { ok: false, error: "provider account not found" };
  }
  if (patch.providerId !== undefined && !state.providers.has(patch.providerId)) {
    return { ok: false, error: `unknown provider: ${patch.providerId}` };
  }
  if (
    patch.usageLimitCooldownSeconds !== undefined &&
    (!Number.isInteger(patch.usageLimitCooldownSeconds) || patch.usageLimitCooldownSeconds <= 0)
  ) {
    return { ok: false, error: "usageLimitCooldownSeconds must be a positive integer" };
  }
  const next: ProviderAccountRecord = {
    ...existing,
    updatedAt: state.now(),
    ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.usageLimitCooldownSeconds !== undefined
      ? { usageLimitCooldownSeconds: patch.usageLimitCooldownSeconds }
      : {}),
  };
  state.providerAccounts.set(id, next);
  if (state.storage) {
    queueWrite(
      state,
      state.storage
        .updateProviderAccount({
          id,
          expectedUpdatedAt: existing.updatedAt,
          updatedAt: next.updatedAt,
          patch: {
            ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.usageLimitCooldownSeconds !== undefined
              ? { usageLimitCooldownSeconds: patch.usageLimitCooldownSeconds }
              : {}),
          },
        })
        .then(() => undefined),
    );
  }
  return { ok: true, account: { ...next } };
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
  state.providerAccounts.set(id, account);
  if (state.storage) {
    queueWrite(
      state,
      state.storage
        .clearProviderAccountUsageLimit({
          id,
          expectedUpdatedAt: existing.updatedAt,
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
  const account = { ...existing, usageLimitedUntil: null, updatedAt: state.now() };
  const cleared = await state.storage.clearProviderAccountUsageLimit({
    id,
    expectedUpdatedAt: existing.updatedAt,
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
