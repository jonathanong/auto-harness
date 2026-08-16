"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { mutateInventory, upsertHostRepository, type HostRepository } from "@auto-harness/shared";
import { Button, Input, Label, Textarea, WithTooltip } from "@auto-harness/ui";

export function HostRepoSettingsForm({ hostId, repo }: { hostId: string; repo: HostRepository }) {
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
        data-pw={`repo-settings-open-${repo.id}`}
        onClick={() => setOpen(true)}
      >
        Edit settings
      </Button>
    );
  }

  return (
    <form
      className="grid w-full gap-2 rounded-md border border-dashed border-border p-3"
      data-pw={`form-repo-settings-${repo.id}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const path = String(fd.get("path") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
        const setupScript = String(fd.get("setupScript") ?? "");
        const terminalHookScript = String(fd.get("terminalHookScript") ?? "");
        if (!path) {
          setError("absolute path is required");
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
        <Label htmlFor={`path-${repo.id}`} tip="Absolute path on this host">
          absolute path
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
          default branch
        </Label>
        <Input
          id={`branch-${repo.id}`}
          name="defaultBranch"
          defaultValue={repo.defaultBranch}
          data-pw={`repo-settings-branch-${repo.id}`}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`setup-${repo.id}`} tip="Optional setup script for this host's attachment">
          setup script
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
          terminal hook script
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
      {error ? (
        <p className="text-sm text-red-700" data-pw={`repo-settings-error-${repo.id}`}>
          {error}
        </p>
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
  );
}
