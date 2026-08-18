"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, Label, WithTooltip, withToast } from "@auto-harness/ui";

import { attachLocalRepo } from "../lib/attach-local-repo.ts";

type Repo = { id: string; name: string; defaultBranch?: string };

/** Control-plane form: attach an existing catalog repository's local path to a selected host. */
export function AttachLocalRepoForm({ hostIds, repos }: { hostIds: string[]; repos: Repo[] }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (hostIds.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No hosts yet. Use <strong>Add host</strong> on the{" "}
        <Link href="/hosts" className="underline">
          Hosts page
        </Link>{" "}
        — it shows the exact command to connect a daemon once the slot exists — then refresh.
      </p>
    );
  }

  if (repos.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No catalog repositories yet. Use <strong>Add repository</strong> above first.
      </p>
    );
  }

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-attach-local-repo"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const hostId = String(fd.get("hostId") ?? "").trim();
        const id = String(fd.get("repositoryId") ?? "").trim();
        const path = String(fd.get("path") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
        if (!hostId || !id || !path) {
          setError("host, repository, and absolute path on the host are required");
          return;
        }
        setPending(true);
        void (async () => {
          const result = await attachLocalRepo({ hostId, id, path, defaultBranch });
          if (!result.ok) {
            setError(result.error);
            setPending(false);
            return;
          }
          const repoName = repos.find((r) => r.id === id)?.name ?? id;
          setPending(false);
          router.push(
            withToast(
              `/repositories/${id}`,
              `Attached ${repoName} on host ${hostId} with no worktrees.`,
            ),
          );
        })();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="hostId" tip="Which host's inventory receives this repository path">
          host
        </Label>
        <select
          id="hostId"
          name="hostId"
          required
          data-pw="attach-repo-agent-id"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          defaultValue={hostIds[0]}
        >
          {hostIds.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="repositoryId" tip="Existing catalog repository to attach to this host">
          repository
        </Label>
        <select
          id="repositoryId"
          name="repositoryId"
          required
          data-pw="attach-repo-catalog-id"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          defaultValue={repos[0]?.id}
        >
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="path"
          tip="Absolute path on the host machine (must exist there). Add worktrees separately, from this host's detail page."
        >
          absolute path on host
        </Label>
        <Input
          id="path"
          name="path"
          required
          placeholder="/Users/you/src/my-repo"
          data-pw="attach-repo-path"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch" tip="Default branch when sessions omit a ref">
          default branch
        </Label>
        <Input
          id="defaultBranch"
          name="defaultBranch"
          defaultValue="main"
          data-pw="attach-repo-branch"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="attach-repo-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Attaches an existing catalog repository's path to a host with zero worktrees">
        <Button type="submit" disabled={pending} data-pw="attach-repo-submit">
          {pending ? "Attaching…" : "Attach repository to host"}
        </Button>
      </WithTooltip>
    </form>
  );
}
