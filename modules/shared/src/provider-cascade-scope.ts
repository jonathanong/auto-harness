import type { HostInventory, HostRepository, HostWorktree } from "./host-inventory.ts";
import type { ProviderCatalog } from "./provider-cascade.ts";

export type ProviderAccountScopeSource = "worktree" | "repository" | "host";
export type ProviderAccountCommandSource =
  | "worktree"
  | "repository"
  | "host"
  | "provider-default"
  | "none";

export type ProviderAccountScopeResolution = {
  providerAccountId: string;
  enabled: boolean;
  enabledSource: ProviderAccountScopeSource;
  commandId: string | undefined;
  commandSource: ProviderAccountCommandSource;
};

/**
 * Resolves every host-attached provider account's effective enabled/command at a given
 * repository or worktree scope, plus which scope's value won — the exact information a
 * ProviderScopeTable needs to render (tri-state Enabled with "inherited from", effective
 * command). Deliberately separate from resolveProviderAccountEnabled/CommandId (which only
 * the scheduler/spawn path uses) rather than refactored to share internals with them — this
 * is UI-only, display-oriented logic, and those two are on the tested, critical spawn path.
 */
export function resolveProviderAccountsForScope(
  hostWorktree: HostWorktree | undefined,
  hostRepository: HostRepository | undefined,
  inventory: HostInventory | undefined,
  catalog: ProviderCatalog,
): ProviderAccountScopeResolution[] {
  return (inventory?.providerAccounts ?? []).map(
    ({ providerAccountId, commandId: hostCommandId }) => {
      const wtOverride = hostWorktree?.providerAccountOverrides?.[providerAccountId];
      const repoOverride = hostRepository?.providerAccountOverrides?.[providerAccountId];

      let enabled: boolean;
      let enabledSource: ProviderAccountScopeSource;
      if (wtOverride?.enabled !== undefined) {
        enabled = wtOverride.enabled;
        enabledSource = "worktree";
      } else if (repoOverride?.enabled !== undefined) {
        enabled = repoOverride.enabled;
        enabledSource = "repository";
      } else {
        enabled = true;
        enabledSource = "host";
      }

      const providerId = catalog.providerAccounts[providerAccountId]?.providerId;
      const providerDefault =
        providerId !== undefined ? catalog.providers[providerId]?.defaultCommandId : undefined;

      let commandId: string | undefined;
      let commandSource: ProviderAccountCommandSource;
      if (wtOverride?.commandId !== undefined) {
        commandId = wtOverride.commandId;
        commandSource = "worktree";
      } else if (repoOverride?.commandId !== undefined) {
        commandId = repoOverride.commandId;
        commandSource = "repository";
      } else if (hostCommandId !== undefined) {
        commandId = hostCommandId;
        commandSource = "host";
      } else if (providerDefault) {
        commandId = providerDefault;
        commandSource = "provider-default";
      } else {
        commandId = undefined;
        commandSource = "none";
      }

      return { providerAccountId, enabled, enabledSource, commandId, commandSource };
    },
  );
}
