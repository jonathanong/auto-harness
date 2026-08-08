import Link from "next/link";
import type { HostRepository } from "@auto-harness/shared";
import {
  AddWorktreeForm,
  RemoveRepoButton,
  RemoveWorktreeButton,
  RepositoryDetail,
  RepositoryDetailsCard,
  SessionsTable,
  Tabs,
  WorktreesHierarchy,
  type WorktreeRepoGroup,
} from "@auto-harness/ui";

import { hostId, apiGet } from "../../../lib/api.ts";
import {
  loadHostInventory,
  loadLiveWorktreesById,
  loadRepoNamesById,
} from "../../../lib/inventory.ts";

export const dynamic = "force-dynamic";

type Session = {
  id: string;
  status: string;
  repositoryId?: string | null;
  targetLabel?: string;
  prompt?: string;
  source?: string;
};

export default async function AgentRepositoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: repositoryId } = await params;
  const { tab } = await searchParams;
  const agent = hostId();
  const inventory = await loadHostInventory(agent);

  const repo: HostRepository | undefined = inventory.repositories.find(
    (r) => r.id === repositoryId,
  );

  if (!repo) {
    return (
      <div className="space-y-4" data-pw="page-repository-detail-not-found">
        <Link href="/repositories" className="text-sm text-muted-foreground hover:underline">
          ← Back to repositories
        </Link>
        <p className="text-sm text-muted-foreground">
          No repository <code className="font-mono">{repositoryId}</code> on agent{" "}
          <code className="font-mono">{agent}</code>.
        </p>
      </div>
    );
  }

  const [liveById, namesById] = await Promise.all([
    loadLiveWorktreesById(agent),
    loadRepoNamesById(),
  ]);
  const repoName = namesById[repo.id] ?? repo.id;
  const group: WorktreeRepoGroup = {
    repositoryId: repo.id,
    repositoryName: repoName,
    repoPath: repo.path,
    worktrees: repo.worktrees.map((wt) => ({
      id: wt.id,
      name: wt.name,
      repositoryId: repo.id,
      path: wt.path,
      labels: wt.labels,
      status: liveById[wt.id]?.status,
      online: liveById[wt.id]?.online,
    })),
  };

  let sessions: Session[] = [];
  try {
    const data = await apiGet<{ items: Session[] }>(
      `/api/v1/sessions?hostId=${encodeURIComponent(agent)}&limit=100`,
    );
    sessions = (data.items ?? []).filter((s) => s.repositoryId === repositoryId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  const activeTab = typeof tab === "string" ? tab : "sessions";

  return (
    <div data-pw="page-repository-detail">
      <RepositoryDetail
        repository={{ ...repo, name: repoName }}
        breadcrumbs={[{ label: "Repositories", href: "/repositories" }, { label: repoName }]}
        actions={
          <>
            {activeTab === "worktrees" ? (
              <AddWorktreeForm
                hostId={agent}
                inventory={inventory}
                repo={repo}
                repoName={repoName}
                browseEndpoint="/api/browse"
              />
            ) : null}
            <RemoveRepoButton hostId={agent} repositoryId={repo.id} redirectTo="/repositories" />
          </>
        }
      >
        <Tabs
          basePath={`/repositories/${encodeURIComponent(repositoryId)}`}
          active={activeTab}
          pw="repository-detail-tabs"
          tabs={[
            {
              key: "sessions",
              label: "Sessions",
              content: (
                <SessionsTable
                  items={sessions}
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
                  hrefBase="/worktrees"
                  emptyMessage="No worktrees yet."
                  renderWorktreeActions={(wt) => (
                    <RemoveWorktreeButton
                      hostId={agent}
                      repositoryId={repo.id}
                      worktreeId={wt.id}
                    />
                  )}
                />
              ),
            },
            {
              key: "settings",
              label: "Settings",
              content: <RepositoryDetailsCard repository={{ ...repo, name: repoName }} />,
            },
          ]}
        />
      </RepositoryDetail>
    </div>
  );
}
