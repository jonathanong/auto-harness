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

/** Persist an account before exposing it through the process cache. */
export async function createProviderAccountDurable(
  state: ControlPlaneState,
  input: Parameters<typeof createProviderAccount>[1],
): Promise<ReturnType<typeof createProviderAccount>> {
  if (!state.storage) return createProviderAccount(state, input);
  const result = prepareCreateProviderAccount(state, input);
  if (!result.ok) return result;
  await state.storage.putProviderAccount({ ...result.account });
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
  const result = prepareUpdateProviderAccount(state, id, patch);
  if (!result.ok) return result;
  const updated = await state.storage.updateProviderAccount({
    id,
    expectedUpdatedAt: result.existing.updatedAt,
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
  if (!state.providerAccounts.has(id)) return { ok: false, error: "provider account not found" };
  await state.storage.deleteProviderAccount(id);
  state.providerAccounts.delete(id);
  return { ok: true };
}
