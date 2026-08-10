import type { ProviderAccountRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  createProviderAccount,
  deleteProviderAccount,
  updateProviderAccount,
} from "./control-plane-provider-accounts.ts";
import {
  prepareCreateProviderAccount,
  prepareUpdateProviderAccount,
} from "./control-plane-provider-accounts-prepare.ts";
import {
  getProviderAccountDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";

export { clearProviderAccountUsageLimitDurable } from "./control-plane-provider-accounts.ts";

/** Persist an account before exposing it through the process cache. */
export async function createProviderAccountDurable(
  state: ControlPlaneState,
  input: Parameters<typeof createProviderAccount>[1],
): Promise<ReturnType<typeof createProviderAccount>> {
  if (!state.storage) return createProviderAccount(state, input);
  await refreshTargetCatalogDurable(state);
  const result = prepareCreateProviderAccount(state, input);
  if (!result.ok) return result;
  const created = await state.storage.putProviderAccount({ ...result.account });
  if (!created) {
    const authoritative = await state.storage.getProviderAccount(result.account.id);
    if (authoritative) state.providerAccounts.set(authoritative.id, authoritative);
    return { ok: false, error: "provider account already exists" };
  }
  state.providerAccounts.set(result.account.id, result.account);
  return { ok: true, account: { ...result.account } };
}

/**
 * Apply an account update through DynamoDB's version compare-and-swap before
 * replacing the cached row. A lost CAS is a conflict, not a phantom update.
 */
export async function updateProviderAccountDurable(
  state: ControlPlaneState,
  id: string,
  patch: Parameters<typeof updateProviderAccount>[2],
): Promise<
  { ok: true; account: ProviderAccountRecord } | { ok: false; error: string; conflict?: boolean }
> {
  if (!state.storage) return updateProviderAccount(state, id, patch);
  await refreshTargetCatalogDurable(state);
  const result = prepareUpdateProviderAccount(state, id, patch);
  if (!result.ok) return result;
  const updated = await state.storage.updateProviderAccount({
    id,
    expectedVersion: result.existing.version ?? 0,
    expectedProviderId: result.existing.providerId,
    updatedAt: result.account.updatedAt,
    patch: result.patch,
  });
  if (!updated) {
    const authoritative = await state.storage.getProviderAccount(id);
    if (authoritative) state.providerAccounts.set(id, authoritative);
    else state.providerAccounts.delete(id);
    return {
      ok: false,
      error: authoritative
        ? "provider account changed concurrently; retry update"
        : "provider account not found",
      ...(authoritative ? { conflict: true } : {}),
    };
  }
  state.providerAccounts.set(id, result.account);
  return { ok: true, account: { ...result.account } };
}

/** Delete durable state before dropping the cached account. */
export async function deleteProviderAccountDurable(
  state: ControlPlaneState,
  id: string,
): Promise<ReturnType<typeof deleteProviderAccount>> {
  if (!state.storage) return deleteProviderAccount(state, id);
  if (!(await getProviderAccountDurable(state, id))) {
    return { ok: false, error: "provider account not found" };
  }
  if (!(await state.storage.deleteProviderAccount(id))) {
    const authoritative = await state.storage.getProviderAccount(id);
    if (authoritative) state.providerAccounts.set(id, authoritative);
    return { ok: false, error: "provider account changed concurrently" };
  }
  state.providerAccounts.delete(id);
  return { ok: true };
}
