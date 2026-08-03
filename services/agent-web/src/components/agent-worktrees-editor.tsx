"use client";

import type { HostInventory, HostRepository } from "@auto-harness/shared";
import { WorktreesHierarchy, type WorktreeRepoGroup } from "@auto-harness/ui";

import { AddWorktreeForm } from "./host-inventory-add-worktree.tsx";
import { RemoveWorktreeButton } from "./remove-worktree-button.tsx";

type LiveWt = {
  status?: string;
  online?: boolean;
};

export function AgentWorktreesEditor({
  agentId,
  inventory,
  liveById,
}: {
  agentId: string;
  inventory: HostInventory;
  liveById: Record<string, LiveWt>;
}) {
  const groups: WorktreeRepoGroup[] = inventory.repositories.map((repo) => ({
    repositoryId: repo.id,
    repoPath: repo.path,
    worktrees: repo.worktrees.map((wt) => {
      const live = liveById[wt.id];
      return {
        id: wt.id,
        repositoryId: repo.id,
        path: wt.path,
        labels: wt.labels,
        status: live?.status,
        online: live?.online,
        agentId,
      };
    }),
  }));

  if (inventory.repositories.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-pw="worktrees-empty">
        No repositories yet. Add one under Repositories first.
      </p>
    );
  }

  return (
    <WorktreesHierarchy
      groups={groups}
      emptyMessage="No worktrees yet."
      hrefBase="/worktrees"
      renderRepoActions={(g) => {
        const repo = inventory.repositories.find((r) => r.id === g.repositoryId) as HostRepository;
        return <AddWorktreeForm agentId={agentId} inventory={inventory} repo={repo} />;
      }}
      renderWorktreeActions={(wt) => (
        <RemoveWorktreeButton
          agentId={agentId}
          inventory={inventory}
          repositoryId={wt.repositoryId}
          worktreeId={wt.id}
        />
      )}
    />
  );
}
