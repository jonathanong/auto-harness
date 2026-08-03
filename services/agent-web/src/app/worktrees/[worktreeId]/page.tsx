import Link from "next/link";
import type { HostRepository, HostWorktree } from "@auto-harness/shared";
import { SessionsTable, WorktreeDetail, type WorktreeRow } from "@auto-harness/ui";

import { RemoveWorktreeButton } from "../../../components/remove-worktree-button.tsx";
import { agentId, apiGet } from "../../../lib/api.ts";
import { loadHostInventory, loadLiveWorktreesById } from "../../../lib/inventory.ts";

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
}: {
  params: Promise<{ worktreeId: string }>;
}) {
  const { worktreeId } = await params;
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
        <Link href="/worktrees" className="text-sm text-muted-foreground hover:underline">
          ← Back to worktrees
        </Link>
        <p className="text-sm text-muted-foreground">
          No worktree <code className="font-mono">{worktreeId}</code> on agent{" "}
          <code className="font-mono">{id}</code>.
        </p>
      </div>
    );
  }

  const liveById = await loadLiveWorktreesById(id);
  const live = liveById[worktreeId];

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
    repositoryId: repo.id,
    path: worktree.path,
    labels: worktree.labels,
    status: live?.status,
    online: live?.online,
    agentId: id,
  };

  return (
    <div data-pw="page-worktree-detail">
      <WorktreeDetail
        worktree={row}
        repoPath={repo.path}
        backHref="/worktrees"
        actions={
          <RemoveWorktreeButton
            agentId={id}
            repositoryId={repo.id}
            worktreeId={worktree.id}
            redirectTo="/worktrees"
          />
        }
      >
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Sessions in this worktree</h3>
          <SessionsTable
            items={sessions}
            hrefBase="/sessions"
            emptyMessage="No recent sessions in this worktree."
          />
        </div>
      </WorktreeDetail>
    </div>
  );
}
