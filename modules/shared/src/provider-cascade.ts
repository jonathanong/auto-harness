import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import type { Provider, ProviderAccount } from "./providers.ts";

/** Narrow catalog lookup — callers build this from their own store (ControlPlaneState maps, etc). */
export type ProviderCatalog = {
  providers: Record<string, Provider>;
  providerAccounts: Record<string, ProviderAccount>;
};

/**
 * Effective enablement of a provider account, walking worktree -> repository -> host.
 * Absent override = inherit from the parent scope; explicit `enabled: false` disables at
 * that scope and stops the walk. Uses `??`, not `||` — an explicit `false` must not be
 * skipped the way an absent (`undefined`) value is.
 */
export function resolveProviderAccountEnabled(
  providerAccountId: string,
  hostWorktree: HostWorktree | undefined,
  hostRepository: HostRepository | undefined,
  inventory: HostInventory | undefined,
): boolean {
  return (
    hostWorktree?.providerAccountOverrides?.[providerAccountId]?.enabled ??
    hostRepository?.providerAccountOverrides?.[providerAccountId]?.enabled ??
    inventory?.providerAccounts?.some((a) => a.providerAccountId === providerAccountId) ??
    false
  );
}

/**
 * Effective command id for a provider account, walking worktree -> repository -> host ->
 * the provider's own default. Returns `undefined` if nothing in the chain resolves (the
 * provider has no default command) — callers must reject in that case, never spawn with
 * no command.
 */
export function resolveProviderAccountCommandId(
  providerAccountId: string,
  hostWorktree: HostWorktree | undefined,
  hostRepository: HostRepository | undefined,
  inventory: HostInventory | undefined,
  catalog: ProviderCatalog,
): string | undefined {
  const hostAccount = inventory?.providerAccounts?.find(
    (a) => a.providerAccountId === providerAccountId,
  );
  const providerId = catalog.providerAccounts[providerAccountId]?.providerId;
  const providerDefault =
    providerId !== undefined ? catalog.providers[providerId]?.defaultCommandId : undefined;
  return (
    hostWorktree?.providerAccountOverrides?.[providerAccountId]?.commandId ??
    hostRepository?.providerAccountOverrides?.[providerAccountId]?.commandId ??
    hostAccount?.commandId ??
    providerDefault ??
    undefined
  );
}
