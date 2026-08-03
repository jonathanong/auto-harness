import Link from "next/link";
import { emptyHostInventory } from "@auto-harness/shared";
import { RepositoriesTable, WorktreesHierarchy, type WorktreeRepoGroup } from "@auto-harness/ui";

import { AddRepoDialog } from "../../components/add-repo-dialog.tsx";
import { HostConfigForm } from "../../components/host-config-form.tsx";
import { agentId } from "../../lib/api.ts";
import { loadHostInventory, loadLiveWorktreesById } from "../../lib/inventory.ts";

export const dynamic = "force-dynamic";

export default async function AgentRepositoriesPage() {
  const id = agentId();
  const [inventory, liveById] = await Promise.all([
    loadHostInventory(id),
    loadLiveWorktreesById(id),
  ]);
  const rows = inventory.repositories.map((r) => ({
    id: r.id,
    name: r.id,
    path: r.path,
    defaultBranch: r.defaultBranch,
  }));
  const worktreeGroups: WorktreeRepoGroup[] = inventory.repositories.map((repo) => ({
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
  }));
  const initialJson = JSON.stringify(
    { repositories: inventory.repositories, commandProfiles: inventory.commandProfiles },
    null,
    2,
  );

  return (
    <div className="mx-auto max-w-3xl space-y-8" data-pw="page-repositories">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="repositories-heading">
            Repositories
          </h2>
          <p className="text-sm text-muted-foreground">
            Agent <code className="font-mono">{id}</code>. Add host repository paths here.
          </p>
        </div>
        <AddRepoDialog agentId={id} inventory={inventory} />
      </div>
      <RepositoriesTable
        items={rows}
        pathLabel="Host path"
        hrefBase="/repositories"
        emptyMessage="No repositories on this agent yet."
      />
      <div className="space-y-2">
        <h3 className="text-lg font-medium">Worktrees by repository</h3>
        <p className="text-sm text-muted-foreground">
          Click a worktree to see its details and sessions. Add or remove worktrees on the{" "}
          <Link href="/worktrees" className="underline">
            Worktrees
          </Link>{" "}
          page.
        </p>
        <WorktreesHierarchy
          groups={worktreeGroups}
          hrefBase="/worktrees"
          emptyMessage="No worktrees yet."
        />
      </div>
      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Advanced: raw host inventory JSON</h3>
        <p className="text-sm text-muted-foreground">
          Power-user edit of full inventory (profiles, bulk worktrees). Prefer the forms when
          possible.
        </p>
        <HostConfigForm
          agentId={id}
          initialJson={initialJson || JSON.stringify(emptyHostInventory(), null, 2)}
        />
      </div>
    </div>
  );
}
