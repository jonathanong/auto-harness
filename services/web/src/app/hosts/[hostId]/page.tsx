import Link from "next/link";
import type { Command, HostInventory, Provider, ProviderAccount } from "@auto-harness/shared";
import { DrainButton, StatusBadge, Tabs, type RepoCatalogEntry } from "@auto-harness/ui";

import { HostProviderAccountsSection } from "../../../components/host-provider-accounts-section.tsx";
import { HostRepositoriesSection } from "../../../components/host-repositories-section.tsx";
import { apiGet } from "../../../lib/api.ts";

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
  try {
    inventory = await apiGet<HostInventory>(`/api/v1/agents/${encodeURIComponent(hostId)}/config`);
  } catch {
    /* no config yet — may still be a live/known agent below */
  }

  let agents: Agent[] = [];
  try {
    const data = await apiGet<{ items: Agent[] }>("/api/v1/agents");
    agents = data.items ?? [];
  } catch {
    /* ignore — status shows unknown */
  }
  const agent = agents.find((a) => a.hostId === hostId);

  if (!inventory && !agent) {
    return (
      <div className="space-y-4" data-pw="page-host-detail-not-found">
        <Link href="/hosts" className="text-sm text-muted-foreground hover:underline">
          ← Back to hosts
        </Link>
        <p className="text-sm text-muted-foreground">
          No host <code className="font-mono">{hostId}</code> known to the control plane.
        </p>
      </div>
    );
  }

  const inv: HostInventory = {
    repositories: [],
    commandProfiles: {},
    ...inventory,
    // A record persisted before this field existed can genuinely lack it at runtime,
    // despite the type saying it's required — never crash on stale storage data.
    providerAccounts: inventory?.providerAccounts ?? [],
  };

  let catalog: RepoCatalogEntry[] = [];
  try {
    const data = await apiGet<{ items: RepoCatalogEntry[] }>("/api/v1/repositories");
    catalog = (data.items ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  } catch {
    /* ignore — attach form shows no options */
  }
  const namesById = Object.fromEntries(catalog.map((r) => [r.id, r.name]));
  const attachedIds = new Set(inv.repositories.map((r) => r.id));
  const unattachedCatalog = catalog.filter((r) => !attachedIds.has(r.id));

  let liveWorktrees: LiveWorktree[] = [];
  try {
    const data = await apiGet<{ items: LiveWorktree[] }>("/api/v1/worktrees");
    liveWorktrees = (data.items ?? []).filter((w) => w.hostId === hostId);
  } catch {
    /* ignore — worktree status shows unknown */
  }
  const liveById = Object.fromEntries(liveWorktrees.map((w) => [w.id, w]));

  let providers: Provider[] = [];
  let providerAccounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  try {
    const [p, a, c] = await Promise.all([
      apiGet<{ items: Provider[] }>("/api/v1/providers"),
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts"),
      apiGet<{ items: Command[] }>("/api/v1/commands"),
    ]);
    providers = p.items ?? [];
    providerAccounts = a.items ?? [];
    commands = c.items ?? [];
  } catch {
    /* ignore — provider accounts section shows nothing to attach */
  }
  const providersById = Object.fromEntries(providers.map((p) => [p.id, p]));
  const providerAccountsById = Object.fromEntries(providerAccounts.map((a) => [a.id, a]));
  const commandsById = Object.fromEntries(commands.map((c) => [c.id, c]));

  const repoCount = inv.repositories.length;
  const worktreeCount = inv.repositories.reduce((n, r) => n + r.worktrees.length, 0);

  return (
    <div className="space-y-6" data-pw="page-host-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/hosts"
            className="text-sm text-muted-foreground hover:underline"
            data-pw="host-detail-back"
          >
            ← Back to hosts
          </Link>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="host-detail-id">
            {hostId}
          </h2>
        </div>
        <DrainButton hostId={hostId} pw="host-detail-drain" />
      </div>

      <Tabs
        basePath={`/hosts/${encodeURIComponent(hostId)}`}
        active={typeof tab === "string" ? tab : "overview"}
        pw="host-detail-tabs"
        tabs={[
          {
            key: "overview",
            label: "Overview",
            content: (
              <dl className="grid gap-4 sm:grid-cols-3" data-pw="host-detail-overview">
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">Status</dt>
                  <dd data-pw="host-detail-status">
                    <StatusBadge status={String(agent?.online ?? false)} />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">Repositories</dt>
                  <dd className="text-sm" data-pw="host-detail-repo-count">
                    {repoCount}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase text-muted-foreground">Worktrees</dt>
                  <dd className="text-sm" data-pw="host-detail-worktree-count">
                    {worktreeCount}
                  </dd>
                </div>
              </dl>
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
              />
            ),
          },
        ]}
      />
    </div>
  );
}
