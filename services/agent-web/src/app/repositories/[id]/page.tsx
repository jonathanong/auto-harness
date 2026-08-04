import Link from "next/link";
import type { HostRepository } from "@auto-harness/shared";
import {
  RepositoryDetail,
  RepositoryDetailsCard,
  SessionsTable,
  Tabs,
  WorktreesHierarchy,
  type WorktreeRepoGroup,
} from "@auto-harness/ui";

import { AddWorktreeForm } from "../../../components/host-inventory-add-worktree.tsx";
import { RemoveRepoButton } from "../../../components/remove-repo-button.tsx";
import { RemoveWorktreeButton } from "../../../components/remove-worktree-button.tsx";
import { agentId, apiGet } from "../../../lib/api.ts";
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
  commandProfile?: string;
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
  const agent = agentId();
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
      `/api/v1/sessions?agentId=${encodeURIComponent(agent)}&limit=100`,
    );
    sessions = (data.items ?? []).filter((s) => s.repositoryId === repositoryId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  return (
    <div data-pw="page-repository-detail">
      <RepositoryDetail
        repository={{ ...repo, name: repoName }}
        backHref="/repositories"
        actions={
          <RemoveRepoButton agentId={agent} repositoryId={repo.id} redirectTo="/repositories" />
        }
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
                  hrefBase="/sessions"
                  emptyMessage="No recent sessions for this repository."
                />
              ),
            },
            {
              key: "worktrees",
              label: "Worktrees",
              content: (
                <div className="space-y-3">
                  <div className="flex justify-end">
                    <AddWorktreeForm
                      agentId={agent}
                      inventory={inventory}
                      repo={repo}
                      repoName={repoName}
                    />
                  </div>
                  <WorktreesHierarchy
                    groups={[group]}
                    hrefBase="/worktrees"
                    emptyMessage="No worktrees yet."
                    renderWorktreeActions={(wt) => (
                      <RemoveWorktreeButton
                        agentId={agent}
                        repositoryId={repo.id}
                        worktreeId={wt.id}
                      />
                    )}
                  />
                </div>
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
