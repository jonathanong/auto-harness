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
  Textarea,
  WithTooltip,
  showToast,
} from "@auto-harness/ui";

export function EditWorktreeForm({
  hostId,
  repositoryId,
  worktree,
  canWriteExecConfig = false,
  hasInheritedExecutionConfig = false,
}: {
  hostId: string;
  repositoryId: string;
  worktree: HostWorktree;
  canWriteExecConfig?: boolean;
  /** Host/repository setup or terminal hooks execute in this worktree's checkout. */
  hasInheritedExecutionConfig?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [setupScriptEdited, setSetupScriptEdited] = useState(false);
  const pathEditingBlocked =
    !canWriteExecConfig && (hasInheritedExecutionConfig || (worktree.setupScript ?? "") !== "");

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (!nextOpen) setSetupScriptEdited(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-pw="worktree-edit-open">
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="edit-worktree-dialog">
        <DialogHeader>
          <DialogTitle>Edit worktree</DialogTitle>
          <DialogDescription>
            Update this worktree's absolute path, scheduler labels, and optional setup script (setup
            scripts require fleet:exec-config).
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          data-pw="form-edit-worktree"
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            // Disabled controls are omitted from FormData. Keep the stored path
            // when an inherited executable action makes its cwd privileged.
            const path = pathEditingBlocked ? worktree.path : String(fd.get("path") ?? "").trim();
            const labels = String(fd.get("labels") ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            const setupScriptEntry = fd.get("setupScript");
            const setupScript = typeof setupScriptEntry === "string" ? setupScriptEntry : "";
            const worktreeSetupScript = setupScript.trim() ? setupScript : undefined;
            if (!path) {
              showToast("absolute path is required", {
                variant: "destructive",
                pw: "worktree-edit-error",
              });
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
                  ...(canWriteExecConfig && setupScriptEdited
                    ? { setupScript: worktreeSetupScript ?? "" }
                    : {}),
                }),
              );
              if (!r.ok) {
                showToast(r.error, { variant: "destructive", pw: "worktree-edit-error" });
                return;
              }
              handleOpenChange(false);
              router.refresh();
            });
          }}
        >
          <div className="space-y-1">
            <Label
              htmlFor="path"
              tip={
                pathEditingBlocked
                  ? "Changing this path requires fleet:exec-config because setup or a terminal hook runs in its checkout."
                  : "Absolute path on this host"
              }
            >
              Absolute Path
            </Label>
            <Input
              id="path"
              name="path"
              defaultValue={worktree.path}
              required
              disabled={pathEditingBlocked}
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
          {canWriteExecConfig ? (
            <div className="space-y-1">
              <Label
                htmlFor="worktreeSetupScript"
                tip="Optional worktree override; leave blank to inherit repository setup. Requires fleet:exec-config."
              >
                Setup Script
              </Label>
              <Textarea
                id="worktreeSetupScript"
                name="setupScript"
                rows={5}
                defaultValue={worktree.setupScript ?? ""}
                onChange={() => setSetupScriptEdited(true)}
                className="font-mono text-xs"
                data-pw="worktree-edit-setup-script"
              />
            </div>
          ) : null}
          <div className="flex gap-2">
            <WithTooltip tip="Save changes to this worktree">
              <Button type="submit" size="sm" disabled={pending} data-pw="worktree-edit-submit">
                {pending ? "Saving…" : "Save"}
              </Button>
            </WithTooltip>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
