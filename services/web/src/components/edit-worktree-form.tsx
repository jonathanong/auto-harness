"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { mutateInventory, updateHostWorktree, type HostWorktree } from "@auto-harness/shared";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  WithTooltip,
} from "@auto-harness/ui";

export function EditWorktreeForm({
  hostId,
  repositoryId,
  worktree,
}: {
  hostId: string;
  repositoryId: string;
  worktree: HostWorktree;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-pw="worktree-edit-open">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="edit-worktree-dialog">
        <DialogHeader>
          <DialogTitle>Edit worktree</DialogTitle>
          <DialogDescription>
            Update this worktree's absolute path and scheduler labels.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
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
              // Built from a fresh read, not the page-load `inventory` prop: another tab may
              // have changed the document since this page rendered.
              const r = await mutateInventory(hostId, (current) =>
                updateHostWorktree(current, repositoryId, {
                  id: worktree.id,
                  name: worktree.name,
                  path,
                  labels,
                }),
              );
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
              Absolute Path
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
              Labels (Comma-Separated)
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
      </DialogContent>
    </Dialog>
  );
}
