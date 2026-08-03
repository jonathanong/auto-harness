import Link from "next/link";
import type { HostRepository } from "@auto-harness/shared";
import {
  RepositoryDetail,
  SessionsTable,
  WorktreesHierarchy,
  type WorktreeRepoGroup,
} from "@auto-harness/ui";

import { RemoveRepoButton } from "../../../components/remove-repo-button.tsx";
import { agentId, apiGet } from "../../../lib/api.ts";
import { loadHostInventory, loadLiveWorktreesById } from "../../../lib/inventory.ts";

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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: repositoryId } = await params;
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

  const liveById = await loadLiveWorktreesById(agent);
  const group: WorktreeRepoGroup = {
    repositoryId: repo.id,
    repoPath: repo.path,
    worktrees: repo.worktrees.map((wt) => ({
      id: wt.id,
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
        repository={repo}
        backHref="/repositories"
        actions={
          <RemoveRepoButton agentId={agent} repositoryId={repo.id} redirectTo="/repositories" />
        }
      >
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Worktrees</h3>
          <WorktreesHierarchy
            groups={[group]}
            hrefBase="/worktrees"
            emptyMessage="No worktrees yet — add them on the Worktrees page."
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Sessions in this repository</h3>
          <SessionsTable
            items={sessions}
            hrefBase="/sessions"
            emptyMessage="No recent sessions for this repository."
          />
        </div>
      </RepositoryDetail>
    </div>
  );
}
