import Link from "next/link";
import { SessionsTable, WorktreeDetail, type WorktreeRow } from "@auto-harness/ui";

import { apiGet } from "../../../lib/api.ts";

export const dynamic = "force-dynamic";

type Wt = {
  id: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  agentId?: string;
  labels?: string[];
};
type Repo = { id: string; url: string };
type Session = {
  id: string;
  status: string;
  worktreeId?: string | null;
  agentId?: string | null;
  commandProfile?: string;
  prompt?: string;
  source?: string;
};

export default async function WorktreeDetailPage({
  params,
}: {
  params: Promise<{ worktreeId: string }>;
}) {
  const { worktreeId } = await params;

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
  let sessions: Session[] = [];
  try {
    const repos = await apiGet<{ items: Repo[] }>("/api/v1/repositories");
    repoPath = repos.items?.find((r) => r.id === worktree!.repositoryId)?.url;
  } catch {
    /* ignore — repo path stays unknown */
  }
  try {
    // No server-side worktreeId filter yet — scan the most recent page and filter here.
    const data = await apiGet<{ items: Session[] }>("/api/v1/sessions?limit=100");
    sessions = (data.items ?? []).filter((s) => s.worktreeId === worktreeId);
  } catch {
    /* ignore — sessions section stays empty */
  }

  const row: WorktreeRow = {
    id: worktree.id,
    repositoryId: worktree.repositoryId,
    path: worktree.path,
    labels: worktree.labels,
    status: worktree.status,
    online: worktree.online,
    agentId: worktree.agentId,
  };

  return (
    <div data-pw="page-worktree-detail">
      <WorktreeDetail worktree={row} repoPath={repoPath} backHref="/worktrees">
        <div className="space-y-2">
          <h3 className="text-lg font-medium">Sessions in this worktree</h3>
          <SessionsTable
            items={sessions}
            showAgent
            emptyMessage="No recent sessions in this worktree."
          />
        </div>
      </WorktreeDetail>
    </div>
  );
}
