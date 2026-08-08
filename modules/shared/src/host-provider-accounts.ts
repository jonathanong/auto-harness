import type { HostInventory, HostProviderAccount } from "./host-inventory.ts";

/** Attach a provider account to a host, replacing any existing attachment for the same account. */
export function attachProviderAccountToHost(
  existing: HostInventory,
  account: HostProviderAccount,
): HostInventory {
  const next = existing.providerAccounts.filter(
    (a) => a.providerAccountId !== account.providerAccountId,
  );
  next.push({ ...account });
  return { ...existing, providerAccounts: next };
}

/** Detach a provider account from a host. No-op if it wasn't attached. */
export function detachProviderAccountFromHost(
  existing: HostInventory,
  providerAccountId: string,
): HostInventory {
  return {
    ...existing,
    providerAccounts: existing.providerAccounts.filter(
      (a) => a.providerAccountId !== providerAccountId,
    ),
  };
}

/**
 * Set (or, when `commandId` is `undefined`, clear) a host-level command override for an
 * attached provider account. No-op if the account isn't attached to this host.
 */
export function setHostProviderAccountCommand(
  existing: HostInventory,
  providerAccountId: string,
  commandId: string | undefined,
): HostInventory {
  return {
    ...existing,
    providerAccounts: existing.providerAccounts.map((a) => {
      if (a.providerAccountId !== providerAccountId) {
        return a;
      }
      const next = { ...a };
      if (commandId === undefined) {
        delete next.commandId;
      } else {
        next.commandId = commandId;
      }
      return next;
    }),
  };
}
