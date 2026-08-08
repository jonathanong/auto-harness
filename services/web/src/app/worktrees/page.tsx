import { WorktreesHierarchy, groupWorktreesByRepo } from "@auto-harness/ui";

import { apiGet } from "../../lib/api.ts";

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
type Repo = { id: string; name: string };

export default async function WorktreesPage() {
  let items: Wt[] = [];
  let namesById: Record<string, string> = {};
  let error: string | null = null;
  try {
    const [wts, repos] = await Promise.all([
      apiGet<{ items: Wt[] }>("/api/v1/worktrees"),
      apiGet<{ items: Repo[] }>("/api/v1/repositories"),
    ]);
    items = wts.items ?? [];
    namesById = Object.fromEntries((repos.items ?? []).map((r) => [r.id, r.name]));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const groups = groupWorktreesByRepo(
    items.map((w) => ({
      id: w.id,
      name: w.name,
      repositoryId: w.repositoryId,
      path: w.path,
      status: w.status,
      online: w.online,
      hostId: w.hostId,
      labels: w.labels,
    })),
  ).map((g) => ({
    ...g,
    repositoryName: namesById[g.repositoryId] ?? g.repositoryId,
    repoHrefBase: "/repositories",
  }));

  return (
    <div className="space-y-4" data-pw="page-worktrees">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="worktrees-heading">
          Worktrees
        </h2>
        <p className="text-sm text-muted-foreground">
          Fleet worktrees grouped by repository. Edit host paths and add worktrees on each host
          pane.
        </p>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <WorktreesHierarchy
        groups={groups}
        showHost
        hrefBase="/worktrees"
        emptyMessage="No worktrees registered yet."
      />
    </div>
  );
}
