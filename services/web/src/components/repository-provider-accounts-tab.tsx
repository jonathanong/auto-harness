import Link from "next/link";
import {
  resolveProviderAccountsForScope,
  type Command,
  type HostInventory,
  type Provider,
  type ProviderAccount,
  type ProviderCatalog,
} from "@auto-harness/shared";

import { ProviderScopeTable } from "./provider-scope-table.tsx";

/**
 * A catalog repository can be attached to several hosts, and the override is per
 * (host, repository) — so this renders one labeled ProviderScopeTable block per attached
 * host, with the host's id in the data-pw prefix to keep selectors unique.
 */
export function RepositoryProviderAccountsTab({
  repositoryId,
  attachedHosts,
  hostInventories,
  catalog,
  providerAccountsById,
  providersById,
  commandsById,
}: {
  repositoryId: string;
  attachedHosts: Array<{ hostId: string }>;
  /** Same order/length as `attachedHosts`; `null` where the fetch failed. */
  hostInventories: Array<HostInventory | null>;
  catalog: ProviderCatalog;
  providerAccountsById: Record<string, ProviderAccount>;
  providersById: Record<string, Provider>;
  commandsById: Record<string, Command>;
}) {
  if (attachedHosts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Not attached to any host yet — attach it on a host's detail page first.
      </p>
    );
  }

  return (
    <div className="space-y-6" data-pw="repository-provider-accounts-tab">
      {attachedHosts.map((h, i) => {
        const inventory = hostInventories[i];
        const hostRepo = inventory?.repositories.find((r) => r.id === repositoryId);
        const resolutions = resolveProviderAccountsForScope(
          undefined,
          hostRepo,
          inventory ?? undefined,
          catalog,
        );
        return (
          <div key={h.hostId} className="space-y-2">
            <Link
              href={`/hosts/${encodeURIComponent(h.hostId)}`}
              className="font-mono text-sm font-medium hover:underline"
              data-pw={`repository-provider-accounts-host-${h.hostId}`}
            >
              {h.hostId}
            </Link>
            <ProviderScopeTable
              hostId={h.hostId}
              scope={{ repositoryId }}
              inheritedEnabledLabel="host"
              resolutions={resolutions}
              overridesAtScope={hostRepo?.providerAccountOverrides ?? {}}
              accountsById={providerAccountsById}
              providersById={providersById}
              commandsById={commandsById}
            />
          </div>
        );
      })}
    </div>
  );
}
