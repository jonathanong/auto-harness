import {
  AddWorktreeForm,
  RemoveRepoButton,
  RemoveWorktreeButton,
  SectionError,
  WorktreesHierarchy,
  type RepoCatalogEntry,
  type WorktreeRepoGroup,
} from "@auto-harness/ui";
import type { HostInventory } from "@auto-harness/shared";

import { HostAddRepoForm } from "./host-add-repo-form.tsx";
import { HostRepoSettingsForm } from "./host-repo-settings-form.tsx";

type LiveWorktree = { status?: string; online?: boolean };

function hasRepositoryExecConfig(repository: HostInventory["repositories"][number]): boolean {
  return (
    (repository.setupScript ?? "") !== "" ||
    (repository.terminalHookScript ?? "") !== "" ||
    repository.worktrees.some((worktree) => (worktree.setupScript ?? "") !== "")
  );
}

function hasWorktreeExecConfig(
  worktree: HostInventory["repositories"][number]["worktrees"][number] | undefined,
) {
  return (worktree?.setupScript ?? "") !== "";
}

export function HostRepositoriesSection({
  hostId,
  inventory,
  namesById,
  unattachedCatalog,
  liveById,
  catalogError,
  worktreesError,
  canWrite = true,
  canWriteExecConfig = false,
}: {
  hostId: string;
  inventory: HostInventory;
  namesById: Record<string, string>;
  unattachedCatalog: RepoCatalogEntry[];
  liveById: Record<string, LiveWorktree>;
  catalogError?: string | null;
  worktreesError?: string | null;
  canWrite?: boolean;
  canWriteExecConfig?: boolean;
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
      {canWrite ? (
        <section className="space-y-2">
          <h3 className="text-lg font-medium">Attach a repository</h3>
          {catalogError ? (
            <SectionError
              resource="the repository catalog"
              message={catalogError}
              selector="host-repositories-catalog"
            />
          ) : (
            <HostAddRepoForm hostId={hostId} catalog={unattachedCatalog} />
          )}
        </section>
      ) : null}
      <section className="space-y-3">
        <h3 className="text-lg font-medium">Attached repositories</h3>
        {worktreesError ? (
          <SectionError
            resource="live worktree status"
            message={worktreesError}
            selector="host-repositories-worktree-status"
          />
        ) : null}
        <WorktreesHierarchy
          groups={groups}
          hrefBase="/worktrees"
          emptyMessage="No repositories attached to this host yet."
          renderRepoActions={(g) => {
            const repo = reposById[g.repositoryId];
            if (!canWrite) return null;
            return (
              <div className="flex w-full flex-wrap items-start justify-between gap-3">
                <HostRepoSettingsForm
                  hostId={hostId}
                  repo={repo}
                  canWriteExecConfig={canWriteExecConfig}
                  hasInheritedSetupScript={(inventory.setupScript ?? "") !== ""}
                />
                <div className="flex gap-2">
                  <AddWorktreeForm
                    hostId={hostId}
                    repo={repo}
                    repoName={namesById[repo.id] ?? repo.id}
                    canWriteExecConfig={canWriteExecConfig}
                  />
                  {canWriteExecConfig || !hasRepositoryExecConfig(repo) ? (
                    <RemoveRepoButton hostId={hostId} repositoryId={repo.id} />
                  ) : null}
                </div>
              </div>
            );
          }}
          renderWorktreeActions={(wt) => {
            const inventoryWorktree = reposById[wt.repositoryId]?.worktrees.find(
              (worktree) => worktree.id === wt.id,
            );
            return canWrite && (canWriteExecConfig || !hasWorktreeExecConfig(inventoryWorktree)) ? (
              <RemoveWorktreeButton
                hostId={hostId}
                repositoryId={wt.repositoryId}
                worktreeId={wt.id}
              />
            ) : null;
          }}
        />
      </section>
    </div>
  );
}
