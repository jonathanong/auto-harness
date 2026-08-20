"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea, WithTooltip, withToast } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export function RepoCreateForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-repo-catalog"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const body: Record<string, string> = {
          name: String(fd.get("name") ?? ""),
          url: String(fd.get("url") ?? ""),
          defaultBranch: String(fd.get("defaultBranch") ?? "main"),
          setupScript: String(fd.get("setupScript") ?? ""),
        };
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/repositories`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            setError(await apiErrorMessage(res));
            return;
          }
          const created = (await res.json()) as { id: string };
          router.push(withToast(`/repositories/${created.id}`, "Repository created."));
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="name"
          tip="Lowercase letters, numbers, and dashes only; unique across the catalog. Id is auto-generated."
        >
          name
        </Label>
        <Input id="name" name="name" required data-pw="repo-catalog-name" />
      </div>
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
          required
          placeholder="https://github.com/org/repo.git"
          data-pw="repo-catalog-url"
        />
        <p className="text-xs text-muted-foreground">
          Git remote URL recorded for this catalog repository (HTTPS or SSH). Not a filesystem
          path on the host — that is set when attaching the repo to a host.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch" tip="Default branch name for sessions that omit ref">
          defaultBranch
        </Label>
        <Input
          id="defaultBranch"
          name="defaultBranch"
          defaultValue="main"
          data-pw="repo-catalog-branch"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="setupScript" tip="Optional catalog-level setup script">
          setup script
        </Label>
        <Textarea
          id="setupScript"
          name="setupScript"
          rows={3}
          className="font-mono text-xs"
          data-pw="repo-catalog-setup"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="repo-catalog-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Register a repository in the control-plane catalog only">
        <Button type="submit" disabled={pending} data-pw="repo-catalog-submit">
          {pending ? "Saving…" : "Create repository"}
        </Button>
      </WithTooltip>
    </form>
  );
}
