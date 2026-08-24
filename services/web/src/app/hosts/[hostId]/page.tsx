/* eslint-disable max-lines -- host detail composes inventory and exec-config write gates. */
import type { Command, HostInventory, Provider, ProviderAccount } from "@auto-harness/shared";
import { SectionError, Tabs, type RepoCatalogEntry } from "@auto-harness/ui";
import { HostAdvancedTab } from "../../../components/host-advanced-tab.tsx";
import { HostDetailHeader } from "../../../components/host-detail-header.tsx";
import { HostNotFound } from "../../../components/host-not-found.tsx";
import { HostOverviewSection } from "../../../components/host-overview-section.tsx";
import { HostProviderAccountsSection } from "../../../components/host-provider-accounts-section.tsx";
import { HostRepositoriesSection } from "../../../components/host-repositories-section.tsx";
import { ApiError, apiGet, apiGetAllPages } from "../../../lib/api.ts";
import { decodeRouteParam } from "../../../lib/decode-route-param.ts";
import { can, loadPrincipal } from "../../../lib/principal.ts";
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export const dynamic = "force-dynamic";
type Agent = {
  hostId: string;
  online: boolean;
  connectedAt?: string | null;
  daemonStartedAt?: string | null;
  restartCount?: number;
  lastRestartDetectedAt?: string | null;
  daemonVersion?: string | null;
  gitVersion?: string | null;
  gitReady?: boolean;
  gitReadinessReason?: string | null;
  environmentReadiness?: Record<string, { required: string[]; missing: string[]; ready: boolean }>;
};
type LiveWorktree = { id: string; hostId?: string; status?: string; online?: boolean };

export default async function HostDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ hostId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const hostId = decodeRouteParam((await params).hostId);
  const { tab } = await searchParams;
  const principal = await loadPrincipal();
  const canDrain = can(principal, "fleet:drain");
  const canWriteInventory = can(principal, "fleet:inventory");
  const canWriteExecConfig = can(principal, "fleet:exec-config");
  const canWriteProviderAccounts = can(principal, "providers:accounts");
  let inventory: (HostInventory & { version?: number }) | null = null;
  let inventoryError: string | null = null;
  try {
    inventory = await apiGet<HostInventory & { version?: number }>(
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
    return <HostNotFound hostId={hostId} message={inventoryError ?? agentsError} />;
  }

  if (inventoryError) {
    // The agent is known, but the inventory failed to load for a real reason. Never fabricate an
    // empty inventory: that would mislead the UI and risk replacing the real host configuration.
    return (
      <div className="space-y-6">
        <HostDetailHeader hostId={hostId} canDrain={canDrain} />
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
  const inventoryJson = JSON.stringify(inv, null, 2);

  let catalog: RepoCatalogEntry[] = [];
  let catalogError: string | null = null;
  try {
    catalog = (await apiGetAllPages<RepoCatalogEntry>("/api/v1/repositories")).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch (error) {
    catalogError = errorMessage(error);
  }
  const namesById = Object.fromEntries(catalog.map((r) => [r.id, r.name]));
  const attachedIds = new Set(inv.repositories.map((r) => r.id));
  const unattachedCatalog = catalog.filter((r) => !attachedIds.has(r.id));

  let liveWorktrees: LiveWorktree[] = [];
  let worktreesError: string | null = null;
  try {
    const data = await apiGet<{ items: LiveWorktree[] }>(
      `/api/v1/worktrees?hostId=${encodeURIComponent(hostId)}`,
    );
    liveWorktrees = data.items ?? [];
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
      <HostDetailHeader hostId={hostId} canDrain={canDrain} />

      <Tabs
        basePath={`/hosts/${encodeURIComponent(hostId)}`}
        active={typeof tab === "string" ? tab : "overview"}
        pw="host-detail-tabs"
        tabs={[
          {
            key: "overview",
            label: "Overview",
            content: (
              <HostOverviewSection
                hostId={hostId}
                agent={agent}
                agentsError={agentsError}
                repoCount={repoCount}
                worktreeCount={worktreeCount}
                repositoryNames={namesById}
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
                canWrite={canWriteInventory}
                canWriteExecConfig={canWriteExecConfig}
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
                canWrite={canWriteProviderAccounts}
              />
            ),
          },
          {
            key: "advanced",
            label: "Advanced",
            content: (
              <HostAdvancedTab
                hostId={hostId}
                initialJson={inventoryJson}
                initialVersion={inventory?.version ?? 0}
                setupScript={inv.setupScript}
                allowedRoots={inv.allowedRoots}
                requiredEnvironment={inv.requiredEnvironment}
                canWriteInventory={canWriteInventory}
                canWriteExecConfig={canWriteExecConfig}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
