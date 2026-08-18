import Link from "next/link";
import type { Command, HostInventory, Provider, ProviderAccount } from "@auto-harness/shared";
import { SectionError, Tabs, type RepoCatalogEntry } from "@auto-harness/ui";

import { HostDetailHeader } from "../../../components/host-detail-header.tsx";
import { HostOverviewTab } from "../../../components/host-overview-tab.tsx";
import { HostProviderAccountsSection } from "../../../components/host-provider-accounts-section.tsx";
import { HostRepositoriesSection } from "../../../components/host-repositories-section.tsx";
import { ApiError, apiGet } from "../../../lib/api.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const dynamic = "force-dynamic";

type Agent = { hostId: string; online: boolean };
type LiveWorktree = { id: string; hostId?: string; status?: string; online?: boolean };

export default async function HostDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ hostId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { hostId } = await params;
  const { tab } = await searchParams;

  let inventory: HostInventory | null = null;
  let inventoryError: string | null = null;
  try {
    inventory = await apiGet<HostInventory>(
      `/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
    );
  } catch (error) {
    // A 404 genuinely means "no config yet" — may still be a live/known agent below.
    // Anything else is a real failure, not evidence the host doesn't exist.
    if (!(error instanceof ApiError && error.status === 404)) {
      inventoryError = errorMessage(error);
    }
  }

  let agents: Agent[] = [];
  let agentsError: string | null = null;
  try {
    const data = await apiGet<{ items: Agent[] }>("/api/v1/hosts");
    agents = data.items ?? [];
  } catch (error) {
    agentsError = errorMessage(error);
  }
  const agent = agents.find((a) => a.hostId === hostId);

  if (!inventory && !agent) {
    return (
      <div className="space-y-4" data-pw="page-host-detail-not-found">
        <Link href="/hosts" className="text-sm text-muted-foreground hover:underline">
          ← Back to hosts
        </Link>
        {inventoryError || agentsError ? (
          <SectionError
            resource={`host ${hostId}`}
            message={inventoryError ?? agentsError ?? ""}
            selector="host-detail-lookup"
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No host <code className="font-mono">{hostId}</code> known to the control plane.
          </p>
        )}
      </div>
    );
  }

  if (inventoryError) {
    // The agent is known (the not-found branch above didn't fire) but the inventory
    // itself failed to load for a real reason. Never fabricate an empty inventory here —
    // AddRepoForm/AddWorktreeForm/AttachProviderAccountToHostForm all submit the page-load
    // inventory verbatim via a non-conditional PUT, so a fabricated empty one would
    // silently wipe the host's real repositories and provider accounts on the next save.
    return (
      <div className="space-y-6">
        <HostDetailHeader hostId={hostId} />
        <SectionError
          resource={`host ${hostId}'s inventory`}
          message={inventoryError}
          selector="host-detail-inventory"
        />
      </div>
    );
  }

  const inv: HostInventory = {
    repositories: [],
    ...inventory,
    // A record persisted before this field existed can genuinely lack it at runtime,
    // despite the type saying it's required — never crash on stale storage data.
    providerAccounts: inventory?.providerAccounts ?? [],
  };

  let catalog: RepoCatalogEntry[] = [];
  let catalogError: string | null = null;
  try {
    const data = await apiGet<{ items: RepoCatalogEntry[] }>("/api/v1/repositories");
    catalog = (data.items ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    catalogError = errorMessage(error);
  }
  const namesById = Object.fromEntries(catalog.map((r) => [r.id, r.name]));
  const attachedIds = new Set(inv.repositories.map((r) => r.id));
  const unattachedCatalog = catalog.filter((r) => !attachedIds.has(r.id));

  let liveWorktrees: LiveWorktree[] = [];
  let worktreesError: string | null = null;
  try {
    const data = await apiGet<{ items: LiveWorktree[] }>("/api/v1/worktrees");
    liveWorktrees = (data.items ?? []).filter((w) => w.hostId === hostId);
  } catch (error) {
    worktreesError = errorMessage(error);
  }
  const liveById = Object.fromEntries(liveWorktrees.map((w) => [w.id, w]));

  let providers: Provider[] = [];
  let providerAccounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  let providerCatalogError: string | null = null;
  try {
    const [p, a, c] = await Promise.all([
      apiGet<{ items: Provider[] }>("/api/v1/providers"),
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts"),
      apiGet<{ items: Command[] }>("/api/v1/commands"),
    ]);
    providers = p.items ?? [];
    providerAccounts = a.items ?? [];
    commands = c.items ?? [];
  } catch (error) {
    providerCatalogError = errorMessage(error);
  }
  const providersById = Object.fromEntries(providers.map((p) => [p.id, p]));
  const providerAccountsById = Object.fromEntries(providerAccounts.map((a) => [a.id, a]));
  const commandsById = Object.fromEntries(commands.map((c) => [c.id, c]));

  const repoCount = inv.repositories.length;
  const worktreeCount = inv.repositories.reduce((n, r) => n + r.worktrees.length, 0);

  return (
    <div className="space-y-6" data-pw="page-host-detail">
      <HostDetailHeader hostId={hostId} />

      <Tabs
        basePath={`/hosts/${encodeURIComponent(hostId)}`}
        active={typeof tab === "string" ? tab : "overview"}
        pw="host-detail-tabs"
        tabs={[
          {
            key: "overview",
            label: "Overview",
            content: (
              <HostOverviewTab
                online={agent?.online ?? false}
                agentsError={agentsError}
                repoCount={repoCount}
                worktreeCount={worktreeCount}
              />
            ),
          },
          {
            key: "repositories",
            label: "Repositories & Worktrees",
            content: (
              <HostRepositoriesSection
                hostId={hostId}
                inventory={inv}
                namesById={namesById}
                unattachedCatalog={unattachedCatalog}
                liveById={liveById}
                catalogError={catalogError}
                worktreesError={worktreesError}
              />
            ),
          },
          {
            key: "provider-accounts",
            label: "Provider accounts",
            content: (
              <HostProviderAccountsSection
                hostId={hostId}
                inventory={inv}
                accountsById={providerAccountsById}
                providersById={providersById}
                commandsById={commandsById}
                catalogError={providerCatalogError}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
