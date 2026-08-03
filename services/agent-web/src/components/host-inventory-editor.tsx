"use client";

import type { HostInventory } from "@auto-harness/shared";

import { AddRepoForm } from "./host-inventory-add-repo.tsx";
import { RepoCard } from "./host-inventory-repo.tsx";

export function HostInventoryEditor({
  agentId,
  inventory,
}: {
  agentId: string;
  inventory: HostInventory;
}) {
  return (
    <div className="space-y-6" data-pw="host-inventory-editor">
      <AddRepoForm agentId={agentId} inventory={inventory} />
      <div className="space-y-3">
        <h3 className="text-lg font-medium">Repositories on this agent</h3>
        {inventory.repositories.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-pw="repo-list-empty">
            No repositories yet.
          </p>
        ) : (
          inventory.repositories.map((repo) => (
            <RepoCard key={repo.id} agentId={agentId} inventory={inventory} repo={repo} />
          ))
        )}
      </div>
    </div>
  );
}
