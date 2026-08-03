"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  removeHostWorktree,
  type HostInventory,
  type HostRepository,
} from "@auto-harness/shared";
import { Button, WorktreesHierarchy, WithTooltip, type WorktreeRepoGroup } from "@auto-harness/ui";

import { putInventory } from "./host-inventory-api.ts";
import { AddWorktreeForm } from "./host-inventory-add-worktree.tsx";

type LiveWt = {
  id: string;
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

function RemoveWorktreeButton({
  agentId,
  inventory,
  repositoryId,
  worktreeId,
}: {
  agentId: string;
  inventory: HostInventory;
  repositoryId: string;
  worktreeId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip="Remove this worktree from host inventory (does not delete disk files)">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        data-pw={`worktree-remove-${worktreeId}`}
        onClick={() => {
          start(async () => {
            const next = removeHostWorktree(inventory, repositoryId, worktreeId);
            const r = await putInventory(agentId, next);
            if (r.ok) {
              router.refresh();
            }
          });
        }}
      >
        Remove
      </Button>
    </WithTooltip>
  );
}
