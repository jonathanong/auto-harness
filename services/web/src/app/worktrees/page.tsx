import { WorktreesHierarchy, groupWorktreesByRepo } from "@auto-harness/ui";

import { apiGet } from "../../lib/api.ts";

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

export default async function WorktreesPage() {
  let items: Wt[] = [];
  let error: string | null = null;
  try {
    const data = await apiGet<{ items: Wt[] }>("/api/v1/worktrees");
    items = data.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const groups = groupWorktreesByRepo(
    items.map((w) => ({
      id: w.id,
      repositoryId: w.repositoryId,
      path: w.path,
      status: w.status,
      online: w.online,
      agentId: w.agentId,
      labels: w.labels,
    })),
  );

  return (
    <div className="space-y-4" data-pw="page-worktrees">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="worktrees-heading">
          Worktrees
        </h2>
        <p className="text-sm text-muted-foreground">
          Fleet worktrees grouped by repository. Edit host paths and add worktrees on each agent
          pane.
        </p>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <WorktreesHierarchy
        groups={groups}
        showAgent
        hrefBase="/worktrees"
        emptyMessage="No worktrees registered yet."
      />
    </div>
  );
}
