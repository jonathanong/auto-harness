/* eslint-disable max-lines -- exec-config fields are gated separately from inventory fields. */
"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  mutateInventory,
  parseRequiredEnvironment,
  parseTerminalHookScript,
  upsertHostRepository,
  type HostRepository,
} from "@auto-harness/shared";
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

export function HostRepoSettingsForm({
  hostId,
  repo,
  canWriteExecConfig = false,
}: {
  hostId: string;
  repo: HostRepository;
  canWriteExecConfig?: boolean;
}) {
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
            Update this host's path, default branch, and optional exec-config scripts for this
            repository.
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
            const requiredEnvironmentEntry = fd.get("requiredEnvironment");
            const requiredEnvironmentNames = (
              typeof requiredEnvironmentEntry === "string" ? requiredEnvironmentEntry : ""
            )
              .split(/[\s,]+/)
              .filter(Boolean);
            let requiredEnvironment: string[];
            try {
              requiredEnvironment = parseRequiredEnvironment(
                requiredEnvironmentNames,
                `repository.${repo.id}.requiredEnvironment`,
              );
            } catch (error) {
              showToast(error instanceof Error ? error.message : String(error), {
                variant: "destructive",
                pw: `repo-settings-error-${repo.id}`,
              });
              return;
            }
            if (!path) {
              showToast("absolute path is required", {
                variant: "destructive",
                pw: `repo-settings-error-${repo.id}`,
              });
              return;
            }
            if (canWriteExecConfig) {
              try {
                parseTerminalHookScript(terminalHookScript, repo.id);
              } catch (error) {
                showToast(error instanceof Error ? error.message : String(error), {
                  variant: "destructive",
                  pw: `repo-settings-error-${repo.id}`,
                });
                return;
              }
            }
            start(async () => {
              try {
                // Fresh read rather than the page-load `inventory` prop, so a concurrent edit
                // elsewhere is not silently reverted by this save.
                const r = await mutateInventory(hostId, (current) =>
                  upsertHostRepository(current, {
                    id: repo.id,
                    path,
                    defaultBranch,
                    requiredEnvironment,
                    ...(canWriteExecConfig ? { setupScript, terminalHookScript } : {}),
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
              } catch (error) {
                showToast(error instanceof Error ? error.message : String(error), {
                  variant: "destructive",
                  pw: `repo-settings-error-${repo.id}`,
                });
              }
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
          {canWriteExecConfig ? (
            <>
              <div className="space-y-1">
                <Label
                  htmlFor={`setup-${repo.id}`}
                  tip="Optional setup script for this host's attachment. Requires fleet:exec-config."
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
                  tip="Absolute path to an optional terminal hook script. Requires fleet:exec-config."
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
            </>
          ) : null}
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
