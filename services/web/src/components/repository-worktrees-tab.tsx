import { WorktreesHierarchy, type WorktreeRepoGroup } from "@auto-harness/ui";
import type { HostInventory } from "@auto-harness/shared";

import { attachmentsForRepo } from "./add-worktree-attachments.ts";
import { AddWorktreeForRepo } from "./add-worktree-for-repo.tsx";

/** Worktrees tab on repository detail, including add-worktree on attached hosts. */
export function RepositoryWorktreesTab({
  repositoryId,
  repositoryName,
  group,
  attachedHosts,
  hostInventories,
}: {
  repositoryId: string;
  repositoryName: string;
  group: WorktreeRepoGroup;
  attachedHosts: Array<{ hostId: string }>;
  hostInventories: Array<HostInventory | null>;
}) {
  return (
    <WorktreesHierarchy
      groups={[group]}
      showHost
      hrefBase="/worktrees"
      emptyMessage="No worktrees registered for this repository."
      renderRepoActions={() => (
        <AddWorktreeForRepo
          repositoryId={repositoryId}
          repositoryName={repositoryName}
          attachments={attachmentsForRepo(
            attachedHosts.map((host, index) => ({
              hostId: host.hostId,
              repositories: hostInventories[index]?.repositories,
            })),
            repositoryId,
          )}
        />
      )}
    />
  );
}
