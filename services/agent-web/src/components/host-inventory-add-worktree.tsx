"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  addHostWorktree,
  defaultWorktreePath,
  type HostInventory,
  type HostRepository,
} from "@auto-harness/shared";
import { Button, Input, Label } from "@auto-harness/ui";

import { putInventory } from "./host-inventory-api.ts";

export function AddWorktreeForm({
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
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState("");
  const [path, setPath] = useState("");
  const [labels, setLabels] = useState("echo");

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-pw={`add-worktree-open-${repo.id}`}
        onClick={() => setOpen(true)}
      >
        + Add worktree
      </Button>
    );
  }

  return (
    <form
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw={`form-add-worktree-${repo.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const wtId = id.trim();
        const wtPath = path.trim();
        if (!wtId || !wtPath) {
          setError("worktree id and absolute path are required");
          return;
        }
        start(async () => {
          try {
            const next = addHostWorktree(inventory, repo.id, {
              id: wtId,
              path: wtPath,
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
            setOpen(false);
            setId("");
            setPath("");
            router.refresh();
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        });
      }}
    >
      <p className="text-sm font-medium">New worktree under {repo.id}</p>
      <div className="space-y-1">
        <Label>worktree id</Label>
        <Input
          value={id}
          onChange={(e) => {
            const v = e.target.value;
            setId(v);
            if (!path || path === defaultWorktreePath(repo.path, id)) {
              setPath(v.trim() ? defaultWorktreePath(repo.path, v.trim()) : "");
            }
          }}
          required
          placeholder="runner-1"
          data-pw={`add-worktree-id-${repo.id}`}
        />
      </div>
      <div className="space-y-1">
        <Label>absolute path</Label>
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          required
          placeholder={defaultWorktreePath(repo.path, "my-wt")}
          data-pw={`add-worktree-path-${repo.id}`}
        />
        <p className="text-xs text-muted-foreground">
          Suggested path is only a default — set any absolute path you want.
        </p>
      </div>
      <div className="space-y-1">
        <Label>labels (comma-separated)</Label>
        <Input
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
          data-pw={`add-worktree-labels-${repo.id}`}
        />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={pending}
          data-pw={`add-worktree-submit-${repo.id}`}
        >
          {pending ? "Saving…" : "Save worktree"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
