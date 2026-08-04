import Link from "next/link";
import type { HostRepository, HostWorktree } from "@auto-harness/shared";
import {
  SessionsTable,
  Tabs,
  WorktreeDetail,
  WorktreeDetailsCard,
  type WorktreeRow,
} from "@auto-harness/ui";

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
  worktreeId?: string | null;
  commandProfile?: string;
  prompt?: string;
  source?: string;
};

export default async function AgentWorktreeDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ worktreeId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { worktreeId } = await params;
  const { tab } = await searchParams;
  const id = agentId();
  const inventory = await loadHostInventory(id);

  let repo: HostRepository | undefined;
  let worktree: HostWorktree | undefined;
  for (const r of inventory.repositories) {
    const wt = r.worktrees.find((w) => w.id === worktreeId);
    if (wt) {
      repo = r;
      worktree = wt;
      break;
    }
  }

  if (!repo || !worktree) {
    return (
      <div className="space-y-4" data-pw="page-worktree-detail-not-found">
        <Link href="/repositories" className="text-sm text-muted-foreground hover:underline">
          ← Back to repositories
        </Link>
        <p className="text-sm text-muted-foreground">
          No worktree <code className="font-mono">{worktreeId}</code> on agent{" "}
          <code className="font-mono">{id}</code>.
        </p>
      </div>
    );
  }

  const [liveById, namesById] = await Promise.all([loadLiveWorktreesById(id), loadRepoNamesById()]);
  const live = liveById[worktreeId];
  const repoName = namesById[repo.id] ?? repo.id;

  let sessions: Session[] = [];
  try {
    // No server-side worktreeId filter yet — scan the most recent page and filter here.
    const data = await apiGet<{ items: Session[] }>(
      `/api/v1/sessions?agentId=${encodeURIComponent(id)}&limit=100`,
    );
    sessions = (data.items ?? []).filter((s) => s.worktreeId === worktreeId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  const row: WorktreeRow = {
    id: worktree.id,
    name: worktree.name,
    repositoryId: repo.id,
    path: worktree.path,
    labels: worktree.labels,
    status: live?.status,
    online: live?.online,
    agentId: id,
  };

  const repoWorktreesHref = `/repositories/${encodeURIComponent(repo.id)}?tab=worktrees`;

  return (
    <div data-pw="page-worktree-detail">
      <WorktreeDetail
        worktree={row}
        backHref={repoWorktreesHref}
        backLabel="repository"
        actions={
          <RemoveWorktreeButton
            agentId={id}
            repositoryId={repo.id}
            worktreeId={worktree.id}
            redirectTo={repoWorktreesHref}
          />
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
                  hrefBase="/sessions"
                  emptyMessage="No recent sessions in this worktree."
                />
              ),
            },
            {
              key: "settings",
              label: "Settings",
              content: (
                <WorktreeDetailsCard
                  worktree={row}
                  repositoryName={repoName}
                  repoHrefBase="/repositories"
                  repoPath={repo.path}
                />
              ),
            },
          ]}
        />
      </WorktreeDetail>
    </div>
  );
}
