import Link from "next/link";
import { resolveProviderAccountsForScope, type HostInventory } from "@auto-harness/shared";
import {
  RemoveWorktreeButton,
  SessionsTable,
  Tabs,
  WorktreeDetail,
  WorktreeDetailsCard,
  type WorktreeRow,
} from "@auto-harness/ui";

import { EditWorktreeForm } from "../../../components/edit-worktree-form.tsx";
import { ProviderScopeTable } from "../../../components/provider-scope-table.tsx";
import { apiGet, apiGetAllPages } from "../../../lib/api.ts";
import { fetchProviderCatalogLookups } from "../../../lib/provider-catalog-fetch.ts";

export const dynamic = "force-dynamic";

type Wt = {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  hostId?: string;
  labels?: string[];
};
type Repo = { id: string; name: string; url: string };
type Session = {
  id: string;
  status: string;
  worktreeId?: string | null;
  hostId?: string | null;
  targetLabel?: string;
  prompt?: string;
  source?: string;
};

export default async function WorktreeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ worktreeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { worktreeId } = await params;
  const { tab } = await searchParams;

  let worktree: Wt | undefined;
  try {
    const data = await apiGet<{ items: Wt[] }>("/api/v1/worktrees");
    worktree = (data.items ?? []).find((w) => w.id === worktreeId);
  } catch {
    /* ignore — treated as not found below */
  }

  if (!worktree) {
    return (
      <div className="space-y-4" data-pw="page-worktree-detail-not-found">
        <Link href="/worktrees" className="text-sm text-muted-foreground hover:underline">
          ← Back to worktrees
        </Link>
        <p className="text-sm text-muted-foreground">
          No worktree <code className="font-mono">{worktreeId}</code> registered with the control
          plane.
        </p>
      </div>
    );
  }

  let repoPath: string | undefined;
  let repoName: string | undefined;
  let sessions: Session[] = [];
  try {
    const repos = await apiGetAllPages<Repo>("/api/v1/repositories");
    const repo = repos.find((r) => r.id === worktree!.repositoryId);
    repoPath = repo?.url;
    repoName = repo?.name;
  } catch {
    /* ignore — repo path/name stay unknown */
  }
  try {
    // No server-side worktreeId filter yet — scan the most recent page and filter here.
    const data = await apiGet<{ items: Session[] }>("/api/v1/sessions?limit=100");
    sessions = (data.items ?? []).filter((s) => s.worktreeId === worktreeId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  let inventory: HostInventory | null = null;
  if (worktree.hostId) {
    try {
      inventory = await apiGet<HostInventory>(
        `/api/v1/hosts/${encodeURIComponent(worktree.hostId)}/inventory`,
      );
    } catch {
      /* ignore — edit/remove actions stay hidden below */
    }
  }
  const hostRepository = inventory?.repositories.find((r) => r.id === worktree.repositoryId);
  const hostWorktree = hostRepository?.worktrees.find((w) => w.id === worktree.id);

  const { providersById, providerAccountsById, commandsById, catalog } =
    await fetchProviderCatalogLookups();
  const providerResolutions = resolveProviderAccountsForScope(
    hostWorktree,
    hostRepository,
    inventory ?? undefined,
    catalog,
  );

  const row: WorktreeRow = {
    id: worktree.id,
    name: worktree.name,
    repositoryId: worktree.repositoryId,
    path: worktree.path,
    labels: worktree.labels,
    status: worktree.status,
    online: worktree.online,
    hostId: worktree.hostId,
  };

  return (
    <div data-pw="page-worktree-detail">
      <WorktreeDetail
        worktree={row}
        breadcrumbs={[{ label: "Worktrees", href: "/worktrees" }, { label: worktree.name }]}
        actions={
          worktree.hostId ? (
            <RemoveWorktreeButton
              hostId={worktree.hostId}
              repositoryId={worktree.repositoryId}
              worktreeId={worktree.id}
              redirectTo="/worktrees"
            />
          ) : null
        }
      >
        <Tabs
          basePath={`/worktrees/${encodeURIComponent(worktreeId)}`}
          active={typeof tab === "string" ? tab : "sessions"}
          pw="worktree-detail-tabs"
          tabs={[
            {
              key: "sessions",
              label: "Sessions",
              content: (
                <SessionsTable
                  items={sessions}
                  showHost
                  hrefBase="/sessions"
                  emptyMessage="No recent sessions in this worktree."
                />
              ),
            },
            {
              key: "provider-accounts",
              label: "Provider accounts",
              content: worktree.hostId ? (
                <ProviderScopeTable
                  hostId={worktree.hostId}
                  scope={{ repositoryId: worktree.repositoryId, worktreeId: worktree.id }}
                  inheritedEnabledLabel="repository"
                  resolutions={providerResolutions}
                  overridesAtScope={hostWorktree?.providerAccountOverrides ?? {}}
                  accountsById={providerAccountsById}
                  providersById={providersById}
                  commandsById={commandsById}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  Not associated with a host inventory.
                </p>
              ),
            },
            {
              key: "settings",
              label: "Settings",
              content: (
                <div className="space-y-4">
                  <WorktreeDetailsCard
                    worktree={row}
                    repositoryName={repoName}
                    repoHrefBase="/repositories"
                    repoPath={repoPath}
                    hostHrefBase="/hosts"
                  />
                  {worktree.hostId && hostWorktree ? (
                    <EditWorktreeForm
                      hostId={worktree.hostId}
                      repositoryId={worktree.repositoryId}
                      worktree={hostWorktree}
                    />
                  ) : null}
                </div>
              ),
            },
          ]}
        />
      </WorktreeDetail>
    </div>
  );
}
