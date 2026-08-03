"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  removeHostWorktree,
  updateHostWorktree,
  type HostInventory,
  type HostRepository,
  type HostWorktree,
} from "@auto-harness/shared";
import { Button, Input, Label } from "@auto-harness/ui";

import { putInventory } from "./host-inventory-api.ts";

export function WorktreeRow({
  agentId,
  inventory,
  repo,
  wt,
}: {
  agentId: string;
  inventory: HostInventory;
  repo: HostRepository;
  wt: HostWorktree;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [path, setPath] = useState(wt.path);
  const [labels, setLabels] = useState(wt.labels.join(", "));

  return (
    <div
      className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
      data-pw={`worktree-row-${wt.id}`}
    >
      {!editing ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-sm font-medium">{wt.id}</p>
              <p className="break-all font-mono text-xs text-muted-foreground">{wt.path}</p>
              <p className="text-xs text-muted-foreground">
                labels: {wt.labels.length ? wt.labels.join(", ") : "—"}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-pw={`worktree-edit-${wt.id}`}
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pending}
                data-pw={`worktree-remove-${wt.id}`}
                onClick={() => {
                  setError(null);
                  start(async () => {
                    const next = removeHostWorktree(inventory, repo.id, wt.id);
                    const r = await putInventory(agentId, next);
                    if (!r.ok) {
                      setError(r.error);
                      return;
                    }
                    router.refresh();
                  });
                }}
              >
                Remove
              </Button>
            </div>
          </div>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
        </>
      ) : (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const next = updateHostWorktree(inventory, repo.id, {
                id: wt.id,
                path: path.trim(),
                labels: labels
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
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
            <Label>path (absolute)</Label>
            <Input value={path} onChange={(e) => setPath(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <Label>labels (comma-separated)</Label>
            <Input value={labels} onChange={(e) => setLabels(e.target.value)} />
          </div>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={pending}>
              Save worktree
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
