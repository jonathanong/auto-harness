"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { mutateInventory, upsertHostRepository, type HostRepository } from "@auto-harness/shared";
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

export function HostRepoSettingsForm({ hostId, repo }: { hostId: string; repo: HostRepository }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-pw={`repo-settings-open-${repo.id}`}>
          Edit settings
        </Button>
      </DialogTrigger>
      <DialogContent data-pw={`repo-settings-dialog-${repo.id}`}>
        <DialogHeader>
          <DialogTitle>Edit repository settings</DialogTitle>
          <DialogDescription>
            Update this host's path, default branch, and optional scripts for this repository.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid w-full gap-2"
          data-pw={`form-repo-settings-${repo.id}`}
          onSubmit={(e) => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const path = String(fd.get("path") ?? "").trim();
            const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
            const setupScript = String(fd.get("setupScript") ?? "");
            const terminalHookScript = String(fd.get("terminalHookScript") ?? "");
            const requiredEnvironment = String(fd.get("requiredEnvironment") ?? "")
              .split(/[\s,]+/)
              .filter(Boolean);
            if (!path) {
              showToast("absolute path is required", {
                variant: "destructive",
                pw: `repo-settings-error-${repo.id}`,
              });
              return;
            }
            start(async () => {
              // Fresh read rather than the page-load `inventory` prop, so a concurrent edit
              // elsewhere is not silently reverted by this save.
              const r = await mutateInventory(hostId, (current) =>
                upsertHostRepository(current, {
                  id: repo.id,
                  path,
                  defaultBranch,
                  setupScript,
                  terminalHookScript,
                  requiredEnvironment,
                }),
              );
              if (!r.ok) {
                showToast(r.error, {
                  variant: "destructive",
                  pw: `repo-settings-error-${repo.id}`,
                });
                return;
              }
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <div className="space-y-1">
            <Label
              htmlFor={`required-environment-${repo.id}`}
              tip="Variable names that must be available to child processes before this host can run the repository"
            >
              Required Environment
            </Label>
            <Textarea
              id={`required-environment-${repo.id}`}
              name="requiredEnvironment"
              defaultValue={(repo.requiredEnvironment ?? []).join("\n")}
              rows={3}
              className="font-mono text-xs"
              data-pw={`repo-settings-required-environment-${repo.id}`}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`path-${repo.id}`} tip="Absolute path on this host">
              Absolute Path
            </Label>
            <Input
              id={`path-${repo.id}`}
              name="path"
              defaultValue={repo.path}
              required
              data-pw={`repo-settings-path-${repo.id}`}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`branch-${repo.id}`} tip="Default branch when sessions omit ref">
              Default Branch
            </Label>
            <Input
              id={`branch-${repo.id}`}
              name="defaultBranch"
              defaultValue={repo.defaultBranch}
              data-pw={`repo-settings-branch-${repo.id}`}
            />
          </div>
          <div className="space-y-1">
            <Label
              htmlFor={`setup-${repo.id}`}
              tip="Optional setup script for this host's attachment"
            >
              Setup Script
            </Label>
            <Textarea
              id={`setup-${repo.id}`}
              name="setupScript"
              defaultValue={repo.setupScript ?? ""}
              rows={3}
              className="font-mono text-xs"
              data-pw={`repo-settings-setup-${repo.id}`}
            />
          </div>
          <div className="space-y-1">
            <Label
              htmlFor={`hook-${repo.id}`}
              tip="Optional terminal hook script for this host's attachment"
            >
              Terminal Hook Script
            </Label>
            <Textarea
              id={`hook-${repo.id}`}
              name="terminalHookScript"
              defaultValue={repo.terminalHookScript ?? ""}
              rows={3}
              className="font-mono text-xs"
              data-pw={`repo-settings-hook-${repo.id}`}
            />
          </div>
          <div className="flex gap-2">
            <WithTooltip tip="Save changes to this host's repository attachment">
              <Button
                type="submit"
                size="sm"
                disabled={pending}
                data-pw={`repo-settings-submit-${repo.id}`}
              >
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
