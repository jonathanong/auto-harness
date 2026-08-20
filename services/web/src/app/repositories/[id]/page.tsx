import Link from "next/link";
import {
  RepositoryDetail,
  RepositoryDetailsCard,
  SessionsTable,
  Tabs,
  WorktreesHierarchy,
  type RepositorySummary,
  type WorktreeRepoGroup,
} from "@auto-harness/ui";
import type { HostInventory } from "@auto-harness/shared";

import { AddWorktreeForRepo } from "../../../components/add-worktree-for-repo.tsx";
import { DeleteRepoButton } from "../../../components/delete-repo-button.tsx";
import { EditRepoForm } from "../../../components/edit-repo-form.tsx";
import { RepositoryProviderAccountsTab } from "../../../components/repository-provider-accounts-tab.tsx";
import { apiGet } from "../../../lib/api.ts";
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
type Session = {
  id: string;
  status: string;
  repositoryId?: string | null;
  hostId?: string | null;
  targetLabel?: string;
  prompt?: string;
  source?: string;
};
type AgentHost = { hostId: string; repositories: Array<{ id: string }> };

export default async function RepositoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: repositoryId } = await params;
  const { tab } = await searchParams;

  let repository: RepositorySummary | undefined;
  try {
    repository = await apiGet<RepositorySummary>(
      `/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
    );
  } catch {
    /* treated as not found below */
  }

  if (!repository) {
    return (
      <div className="space-y-4" data-pw="page-repository-detail-not-found">
        <Link href="/repositories" className="text-sm text-muted-foreground hover:underline">
          ← Back to repositories
        </Link>
        <p className="text-sm text-muted-foreground">
          No repository <code className="font-mono">{repositoryId}</code> registered with the
          control plane.
        </p>
      </div>
    );
  }

  let worktrees: Wt[] = [];
  try {
    const data = await apiGet<{ items: Wt[] }>("/api/v1/worktrees");
    worktrees = (data.items ?? []).filter((w) => w.repositoryId === repositoryId);
  } catch {
    /* ignore — worktrees section stays empty */
  }
  const group: WorktreeRepoGroup = {
    repositoryId,
    repositoryName: repository.name ?? repositoryId,
    repoUrl: repository.url ?? undefined,
    worktrees,
  };
  let sessions: Session[] = [];
  try {
    const data = await apiGet<{ items: Session[] }>("/api/v1/sessions?limit=100");
    sessions = (data.items ?? []).filter((s) => s.repositoryId === repositoryId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  let attachedHosts: AgentHost[] = [];
  try {
    const data = await apiGet<{ items: AgentHost[] }>("/api/v1/host-inventories");
    attachedHosts = (data.items ?? []).filter((h) =>
      h.repositories.some((r) => r.id === repositoryId),
    );
  } catch {
    /* ignore — attached-hosts list stays empty */
  }

  const { providersById, providerAccountsById, commandsById, catalog } =
    await fetchProviderCatalogLookups();

  const hostInventories = await Promise.all(
    attachedHosts.map(async (h) => {
      try {
        return await apiGet<HostInventory>(
          `/api/v1/hosts/${encodeURIComponent(h.hostId)}/inventory`,
        );
      } catch {
        return null;
      }
    }),
  );

  return (
    <div data-pw="page-repository-detail">
      <RepositoryDetail
        repository={repository}
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: repository.name ?? repositoryId },
        ]}
      >
        <Tabs
          basePath={`/repositories/${encodeURIComponent(repositoryId)}`}
          active={typeof tab === "string" ? tab : "sessions"}
          pw="repository-detail-tabs"
          tabs={[
            {
              key: "sessions",
              label: "Sessions",
              content: (
                <SessionsTable
                  items={sessions}
                  showHost
                  hrefBase="/sessions"
                  emptyMessage="No recent sessions for this repository."
                />
              ),
            },
            {
              key: "worktrees",
              label: "Worktrees",
              content: (
                <WorktreesHierarchy
                  groups={[group]}
                  showHost
                  hrefBase="/worktrees"
                  emptyMessage="No worktrees registered for this repository."
                  renderRepoActions={() => (
                    <AddWorktreeForRepo
                      repositoryId={repositoryId}
                      repositoryName={repository.name ?? repositoryId}
                      attachments={attachedHosts.flatMap((host, index) => {
                        const repo = hostInventories[index]?.repositories.find(
                          (entry) => entry.id === repositoryId,
                        );
                        return repo ? [{ hostId: host.hostId, repo }] : [];
                      })}
                    />
                  )}
                />
              ),
            },
            {
              key: "provider-accounts",
              label: "Provider accounts",
              content: (
                <RepositoryProviderAccountsTab
                  repositoryId={repositoryId}
                  attachedHosts={attachedHosts}
                  hostInventories={hostInventories}
                  catalog={catalog}
                  providerAccountsById={providerAccountsById}
                  providersById={providersById}
                  commandsById={commandsById}
                />
              ),
            },
            {
              key: "settings",
              label: "Settings",
              content: (
                <div className="space-y-4" data-pw="repository-settings">
                  <RepositoryDetailsCard repository={repository} />
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground">Attached hosts</h3>
                    {attachedHosts.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Not attached to any host yet.</p>
                    ) : (
                      <ul className="space-y-1" data-pw="repository-attached-hosts">
                        {attachedHosts.map((h) => (
                          <li key={h.hostId}>
                            <Link
                              href={`/hosts/${encodeURIComponent(h.hostId)}`}
                              className="font-mono text-sm hover:underline"
                              data-pw={`repository-attached-host-${h.hostId}`}
                            >
                              {h.hostId}
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <EditRepoForm repository={repository} />
                    <DeleteRepoButton
                      repositoryId={repositoryId}
                      attachedHostCount={attachedHosts.length}
                    />
                  </div>
                </div>
              ),
            },
          ]}
        />
      </RepositoryDetail>
    </div>
  );
}
