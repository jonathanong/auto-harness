"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  WithTooltip,
  showToast,
  withToast,
} from "@auto-harness/ui";

import { apiBase, apiErrorMessage, repositoryUrlError } from "@auto-harness/shared";

export function RepoCreateForm() {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-repo-catalog"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const body: Record<string, string> = {
          name: String(fd.get("name") ?? ""),
          url: String(fd.get("url") ?? "").trim(),
          defaultBranch: String(fd.get("defaultBranch") ?? "main"),
          setupScript: String(fd.get("setupScript") ?? ""),
        };
        const urlError = repositoryUrlError(body.url);
        if (urlError) {
          showToast(urlError, { variant: "destructive", pw: "repo-catalog-error" });
          return;
        }
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/repositories`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            showToast(await apiErrorMessage(res), {
              variant: "destructive",
              pw: "repo-catalog-error",
            });
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
          Name
        </Label>
        <Input id="name" name="name" required data-pw="repo-catalog-name" />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="url"
          tip="Credential-free HTTPS URL or SCP-style SSH remote (git@host:path). Host filesystem paths are set when attaching the repository."
        >
          Git URL
        </Label>
        <Input
          id="url"
          name="url"
          required
          placeholder="https://github.com/org/repo.git"
          data-pw="repo-catalog-url"
        />
        <p className="text-xs text-muted-foreground">
          Credential-free HTTPS URL or SCP-style SSH remote (git@host:path). Host filesystem paths
          are set when attaching the repository.
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch" tip="Default branch name for sessions that omit ref">
          Default Branch
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
          Setup Script
        </Label>
        <Textarea
          id="setupScript"
          name="setupScript"
          rows={3}
          className="font-mono text-xs"
          data-pw="repo-catalog-setup"
        />
      </div>
      <WithTooltip tip="Register a repository in the control-plane catalog only">
        <Button type="submit" disabled={pending} data-pw="repo-catalog-submit">
          {pending ? "Saving…" : "Create repository"}
        </Button>
      </WithTooltip>
    </form>
  );
}
