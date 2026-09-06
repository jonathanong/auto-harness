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
  const [principal, inventoryResult, agentsResult] = await Promise.all([
    loadPrincipal(),
    apiGet<HostInventory & { version?: number }>(
      `/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
    ).then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) =>
        error instanceof ApiError && error.status === 404
          ? { value: null, error: null }
          : { value: null, error: errorMessage(error) },
    ),
    apiGet<Agent>(`/api/v1/hosts/${encodeURIComponent(hostId)}`).then(
      (value) => ({ value, error: null as string | null }),
      (error: unknown) =>
        error instanceof ApiError && error.status === 404
          ? { value: null, error: null }
          : { value: null, error: errorMessage(error) },
    ),
  ]);
  const canDrain = can(principal, "fleet:drain");
  const canWriteInventory = can(principal, "fleet:inventory");
  const canWriteExecConfig = can(principal, "fleet:exec-config");
  const canWriteProviderAccounts = can(principal, "providers:accounts");
  const inventory = inventoryResult.value;
  const inventoryError = inventoryResult.error;
  const agent = agentsResult.value;
  const agentsError = agentsResult.error;

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

  const [catalogResult, worktreesResult, providerCatalogResult] = await Promise.all([
    apiGetAllPages<RepoCatalogEntry>("/api/v1/repositories?limit=100").then(
      (items) => ({
        catalog: items.toSorted((a, b) => a.name.localeCompare(b.name)),
        error: null as string | null,
      }),
      (error: unknown) => ({ catalog: [] as RepoCatalogEntry[], error: errorMessage(error) }),
    ),
    apiGet<{ items: LiveWorktree[] }>(
      `/api/v1/worktrees?hostId=${encodeURIComponent(hostId)}&limit=100`,
    ).then(
      (data) => ({ items: data.items ?? [], error: null as string | null }),
      (error: unknown) => ({ items: [] as LiveWorktree[], error: errorMessage(error) }),
    ),
    Promise.all([
      apiGet<{ items: Provider[] }>("/api/v1/providers?limit=100"),
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts?limit=100"),
      apiGet<{ items: Command[] }>("/api/v1/commands?limit=100"),
    ]).then(
      ([p, a, c]) => ({
        providers: p.items ?? [],
        providerAccounts: a.items ?? [],
        commands: c.items ?? [],
        error: null as string | null,
      }),
      (error: unknown) => ({
        providers: [] as Provider[],
        providerAccounts: [] as ProviderAccount[],
        commands: [] as Command[],
        error: errorMessage(error),
      }),
    ),
  ]);
  const catalog = catalogResult.catalog;
  const catalogError = catalogResult.error;
  const namesById = Object.fromEntries(catalog.map((r) => [r.id, r.name]));
  const attachedIds = new Set(inv.repositories.map((r) => r.id));
  const unattachedCatalog = catalog.filter((r) => !attachedIds.has(r.id));
  const liveWorktrees = worktreesResult.items;
  const worktreesError = worktreesResult.error;
  const liveById = Object.fromEntries(liveWorktrees.map((w) => [w.id, w]));
  const providers = providerCatalogResult.providers;
  const providerAccounts = providerCatalogResult.providerAccounts;
  const commands = providerCatalogResult.commands;
  const providerCatalogError = providerCatalogResult.error;
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
                updateConfig={inv.updateConfig}
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
