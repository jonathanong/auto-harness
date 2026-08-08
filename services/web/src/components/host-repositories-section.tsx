import {
  AddRepoForm,
  AddWorktreeForm,
  RemoveRepoButton,
  RemoveWorktreeButton,
  WorktreesHierarchy,
  type RepoCatalogEntry,
  type WorktreeRepoGroup,
} from "@auto-harness/ui";
import type { HostInventory } from "@auto-harness/shared";

import { HostRepoSettingsForm } from "./host-repo-settings-form.tsx";

type LiveWorktree = { status?: string; online?: boolean };

export function HostRepositoriesSection({
  hostId,
  inventory,
  namesById,
  unattachedCatalog,
  liveById,
}: {
  hostId: string;
  inventory: HostInventory;
  namesById: Record<string, string>;
  unattachedCatalog: RepoCatalogEntry[];
  liveById: Record<string, LiveWorktree>;
}) {
  const groups: WorktreeRepoGroup[] = inventory.repositories.map((repo) => ({
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
  const reposById = Object.fromEntries(inventory.repositories.map((r) => [r.id, r]));

  return (
    <div className="space-y-6" data-pw="host-repositories-section">
      <section className="space-y-2">
        <h3 className="text-lg font-medium">Attach a repository</h3>
        <AddRepoForm hostId={hostId} inventory={inventory} catalog={unattachedCatalog} />
      </section>
      <section className="space-y-3">
        <h3 className="text-lg font-medium">Attached repositories</h3>
        <WorktreesHierarchy
          groups={groups}
          hrefBase="/worktrees"
          emptyMessage="No repositories attached to this host yet."
          renderRepoActions={(g) => {
            const repo = reposById[g.repositoryId];
            if (!repo) {
              return null;
            }
            return (
              <div className="flex w-full flex-wrap items-start justify-between gap-3">
                <HostRepoSettingsForm hostId={hostId} inventory={inventory} repo={repo} />
                <div className="flex gap-2">
                  <AddWorktreeForm
                    hostId={hostId}
                    inventory={inventory}
                    repo={repo}
                    repoName={g.repositoryName ?? repo.id}
                  />
                  <RemoveRepoButton hostId={hostId} repositoryId={repo.id} />
                </div>
              </div>
            );
          }}
          renderWorktreeActions={(wt) => (
            <RemoveWorktreeButton
              hostId={hostId}
              repositoryId={wt.repositoryId}
              worktreeId={wt.id}
            />
          )}
        />
      </section>
    </div>
  );
}
