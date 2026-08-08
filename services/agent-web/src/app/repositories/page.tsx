import { WorktreesHierarchy, type WorktreeRepoGroup } from "@auto-harness/ui";

import { AddRepoDialog } from "../../components/add-repo-dialog.tsx";
import { hostId } from "../../lib/api.ts";
import { loadHostInventory, loadLiveWorktreesById, loadRepoCatalog } from "../../lib/inventory.ts";

export const dynamic = "force-dynamic";

export default async function AgentRepositoriesPage() {
  const id = hostId();
  const [inventory, liveById, catalog] = await Promise.all([
    loadHostInventory(id),
    loadLiveWorktreesById(id),
    loadRepoCatalog(),
  ]);
  const namesById = Object.fromEntries(catalog.map((r) => [r.id, r.name]));
  const attachedIds = new Set(inventory.repositories.map((r) => r.id));
  const worktreeGroups: WorktreeRepoGroup[] = inventory.repositories.map((repo) => ({
    repositoryId: repo.id,
    repositoryName: namesById[repo.id] ?? repo.id,
    repoHrefBase: "/repositories",
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
  }));

  return (
    <div className="space-y-8" data-pw="page-repositories">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="repositories-heading">
            Repositories
          </h2>
          <p className="text-sm text-muted-foreground">
            Agent <code className="font-mono">{id}</code>. Click a repository to expand its
            worktrees, or a worktree to see its details and sessions. Add or remove worktrees from a
            repository's own detail page (Worktrees tab).
          </p>
        </div>
        <AddRepoDialog
          hostId={id}
          inventory={inventory}
          catalog={catalog.filter((r) => !attachedIds.has(r.id))}
        />
      </div>
      <WorktreesHierarchy
        groups={worktreeGroups}
        hrefBase="/worktrees"
        emptyMessage="No repositories on this agent yet."
      />
    </div>
  );
}
