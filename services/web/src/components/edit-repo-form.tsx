"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  type RepositorySummary,
  WithTooltip,
} from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export function EditRepoForm({ repository }: { repository: RepositorySummary }) {
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
        data-pw="edit-repo-open"
        onClick={() => setOpen(true)}
      >
        Edit repository
      </Button>
    );
  }

  return (
    <form
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="form-edit-repo"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const url = String(fd.get("url") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
        const setupScript = String(fd.get("setupScript") ?? "");
        const terminalHookScript = String(fd.get("terminalHookScript") ?? "");
        if (!url) {
          setError("url is required");
          return;
        }
        start(async () => {
          const res = await fetch(
            `${apiBase()}/api/v1/repositories/${encodeURIComponent(repository.id)}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ url, defaultBranch, setupScript, terminalHookScript }),
            },
          );
          if (!res.ok) {
            setError(await apiErrorMessage(res));
            return;
          }
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="url"
          tip="Git remote URL recorded for this catalog repository (HTTPS or SSH). Not a filesystem path on the host — that is set when attaching the repo to a host."
        >
          URL / Path
        </Label>
        <Input
          id="url"
          name="url"
          defaultValue={repository.url ?? ""}
          required
          placeholder="https://github.com/org/repo.git"
          data-pw="edit-repo-url"
        />
        <p className="text-xs text-muted-foreground">
          Git remote URL recorded for this catalog repository (HTTPS or SSH). Not a filesystem path
          on the host — that is set when attaching the repo to a host.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch" tip="Default branch when sessions omit ref">
          Default Branch
        </Label>
        <Input
          id="defaultBranch"
          name="defaultBranch"
          defaultValue={repository.defaultBranch ?? "main"}
          data-pw="edit-repo-branch"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="setupScript" tip="Optional catalog-level setup script">
          Setup Script
        </Label>
        <Textarea
          id="setupScript"
          name="setupScript"
          defaultValue={repository.setupScript ?? ""}
          rows={3}
          className="font-mono text-xs"
          data-pw="edit-repo-setup"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="terminalHookScript" tip="Optional catalog-level terminal hook script">
          Terminal Hook Script
        </Label>
        <Textarea
          id="terminalHookScript"
          name="terminalHookScript"
          defaultValue={repository.terminalHookScript ?? ""}
          rows={3}
          className="font-mono text-xs"
          data-pw="edit-repo-hook"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="edit-repo-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <WithTooltip tip="Save changes to this catalog repository">
          <Button type="submit" size="sm" disabled={pending} data-pw="edit-repo-submit">
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
