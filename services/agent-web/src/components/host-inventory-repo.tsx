"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  removeHostRepository,
  upsertHostRepository,
  type HostInventory,
  type HostRepository,
} from "@auto-harness/shared";
import { Button, Input, Label, WithTooltip } from "@auto-harness/ui";

import { putInventory } from "./host-inventory-api.ts";
import { AddWorktreeForm } from "./host-inventory-add-worktree.tsx";
import { WorktreeRow } from "./host-inventory-worktree.tsx";

export function RepoCard({
  agentId,
  inventory,
  repo,
}: {
  agentId: string;
  inventory: HostInventory;
  repo: HostRepository;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(repo.path);
  const [branch, setBranch] = useState(repo.defaultBranch);

  return (
    <div className="space-y-3 rounded-lg border border-border p-4" data-pw={`repo-card-${repo.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="font-mono text-base font-semibold">{repo.id}</h4>
          {!editing ? (
            <>
              <p className="break-all font-mono text-xs text-muted-foreground">{repo.path}</p>
              <p className="text-xs text-muted-foreground">default branch: {repo.defaultBranch}</p>
            </>
          ) : null}
        </div>
        <div className="flex gap-2">
          {!editing ? (
            <WithTooltip tip="Edit path and default branch (worktrees are kept)">
              <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit repo
              </Button>
            </WithTooltip>
          ) : null}
          <WithTooltip tip="Remove this repo and all its worktrees from host inventory">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              data-pw={`repo-remove-${repo.id}`}
              onClick={() => {
                if (
                  !confirm(`Remove repository ${repo.id} and all its worktrees from this agent?`)
                ) {
                  return;
                }
                setError(null);
                start(async () => {
                  const next = removeHostRepository(inventory, repo.id);
                  const r = await putInventory(agentId, next);
                  if (!r.ok) {
                    setError(r.error);
                    return;
                  }
                  router.refresh();
                });
              }}
            >
              Remove repo
            </Button>
          </WithTooltip>
        </div>
      </div>

      {editing ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const next = upsertHostRepository(inventory, {
                id: repo.id,
                path: path.trim(),
                defaultBranch: branch.trim() || "main",
              });
              const r = await putInventory(agentId, next);
              if (!r.ok) {
                setError(r.error);
                return;
              }
              setEditing(false);
              router.refresh();
            });
          }}
        >
          <div className="space-y-1">
            <Label tip="Absolute path to the git repo on this machine">
              absolute path on this host
            </Label>
            <Input value={path} onChange={(e) => setPath(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label tip="Default branch when sessions omit a ref">default branch</Label>
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} />
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              Save repo
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-sm font-medium">Worktrees</p>
        {repo.worktrees.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No worktrees yet. Add one explicitly (id + absolute path).
          </p>
        ) : (
          repo.worktrees.map((wt) => (
            <WorktreeRow key={wt.id} agentId={agentId} inventory={inventory} repo={repo} wt={wt} />
          ))
        )}
        <AddWorktreeForm agentId={agentId} inventory={inventory} repo={repo} />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
    </div>
  );
}
