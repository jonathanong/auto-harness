"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  putInventory,
  updateHostWorktree,
  type HostInventory,
  type HostWorktree,
} from "@auto-harness/shared";
import { Button, Input, Label, WithTooltip } from "@auto-harness/ui";

export function EditWorktreeForm({
  hostId,
  inventory,
  repositoryId,
  worktree,
}: {
  hostId: string;
  inventory: HostInventory;
  repositoryId: string;
  worktree: HostWorktree;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-pw="worktree-edit-open"
        onClick={() => setOpen(true)}
      >
        Edit
      </Button>
    );
  }

  return (
    <form
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="form-edit-worktree"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const path = String(fd.get("path") ?? "").trim();
        const labels = String(fd.get("labels") ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!path) {
          setError("absolute path is required");
          return;
        }
        start(async () => {
          const next = updateHostWorktree(inventory, repositoryId, {
            id: worktree.id,
            name: worktree.name,
            path,
            labels,
          });
          const r = await putInventory(hostId, next);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="path" tip="Absolute path on this host">
          absolute path
        </Label>
        <Input
          id="path"
          name="path"
          defaultValue={worktree.path}
          required
          data-pw="worktree-edit-path"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="labels" tip="Scheduler labels used when matching work to worktrees">
          labels (comma-separated)
        </Label>
        <Input
          id="labels"
          name="labels"
          defaultValue={(worktree.labels ?? []).join(", ")}
          data-pw="worktree-edit-labels"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="worktree-edit-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <WithTooltip tip="Save changes to this worktree">
          <Button type="submit" size="sm" disabled={pending} data-pw="worktree-edit-submit">
            {pending ? "Saving…" : "Save"}
          </Button>
        </WithTooltip>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
