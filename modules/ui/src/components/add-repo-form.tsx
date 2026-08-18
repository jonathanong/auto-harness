"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { mutateInventory, upsertHostRepository } from "@auto-harness/shared";

import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { PathInput } from "./path-input.tsx";
import { withToast } from "./toast.tsx";
import { WithTooltip } from "./tooltip.tsx";

export type RepoCatalogEntry = { id: string; name: string; defaultBranch?: string };

export function AddRepoForm({
  hostId,
  catalog,
  browseEndpoint,
  mutate = mutateInventory,
}: {
  hostId: string;
  catalog: RepoCatalogEntry[];
  /** Filesystem browse endpoint for the path field (host pane only). */
  browseEndpoint?: string | undefined;
  /** Inventory persistence boundary; injectable for in-memory consumers and tests. */
  mutate?: typeof mutateInventory;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (catalog.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No unattached catalog repositories. Register one on the control plane's Repositories page
        first, then attach it here.
      </p>
    );
  }

  return (
    <form
      className="grid gap-3"
      data-pw="form-add-local-repo"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const id = String(fd.get("repositoryId") ?? "").trim();
        const path = String(fd.get("path") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
        if (!id || !path) {
          setError("repository and absolute path are required");
          return;
        }
        start(async () => {
          const r = await mutate(hostId, (current) =>
            upsertHostRepository(current, { id, path, defaultBranch }),
          );
          if (!r.ok) {
            setError(r.error);
            return;
          }
          router.push(withToast(`/repositories/${id}`, "Repository attached with no worktrees."));
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="repositoryId" tip="Existing catalog repository to attach to this host">
          repository
        </Label>
        <select
          id="repositoryId"
          name="repositoryId"
          required
          data-pw="add-repo-catalog-id"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          defaultValue={catalog[0]?.id}
        >
          {catalog.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="path"
          tip="Absolute path that exists on this machine. Worktrees are not created automatically."
        >
          absolute path on this host
        </Label>
        <PathInput
          id="path"
          name="path"
          required
          placeholder="/Users/you/src/my-repo"
          data-pw="add-repo-path"
          browseEndpoint={browseEndpoint}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch" tip="Default branch when a session omits ref">
          default branch
        </Label>
        <Input
          id="defaultBranch"
          name="defaultBranch"
          defaultValue="main"
          data-pw="add-repo-branch"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="add-repo-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Attaches this host's path to an existing catalog repository, zero worktrees">
        <Button type="submit" disabled={pending} data-pw="add-repo-submit">
          {pending ? "Attaching…" : "Attach repository"}
        </Button>
      </WithTooltip>
    </form>
  );
}
