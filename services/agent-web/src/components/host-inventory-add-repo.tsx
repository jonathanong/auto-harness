"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { upsertHostRepository, type HostInventory } from "@auto-harness/shared";
import { Button, Input, Label } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";
import { putInventory } from "./host-inventory-api.ts";

export function AddRepoForm({ agentId, inventory }: { agentId: string; inventory: HostInventory }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3 rounded-lg border border-border p-4"
      data-pw="form-add-local-repo"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setOk(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const id = String(fd.get("id") ?? "").trim();
        const name = String(fd.get("name") ?? "").trim();
        const path = String(fd.get("path") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
        if (!id || !path) {
          setError("id and absolute path are required");
          return;
        }
        start(async () => {
          const base = apiBase();
          const repoRes = await fetch(`${base}/api/v1/repositories`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              id,
              name: name || id,
              url: path,
              defaultBranch,
            }),
          });
          if (!repoRes.ok && repoRes.status !== 400) {
            setError(await repoRes.text());
            return;
          }
          const next = upsertHostRepository(inventory, { id, path, defaultBranch });
          const r = await putInventory(agentId, next);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          setOk(`Repository ${id} added with no worktrees. Add worktrees under the card below.`);
          form.reset();
          router.refresh();
        });
      }}
    >
      <h3 className="text-lg font-medium">Add repository</h3>
      <p className="text-sm text-muted-foreground">
        Registers the catalog entry and host path only. Worktrees are added separately under the
        repo.
      </p>
      <div className="space-y-1">
        <Label htmlFor="id">repository id</Label>
        <Input id="id" name="id" required placeholder="demo" data-pw="add-repo-id" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name">display name</Label>
        <Input id="name" name="name" placeholder="Demo" data-pw="add-repo-name" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="path">absolute path on this host</Label>
        <Input
          id="path"
          name="path"
          required
          placeholder="/Users/you/src/my-repo"
          data-pw="add-repo-path"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch">default branch</Label>
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
      {ok ? (
        <p className="text-sm text-emerald-700" data-pw="add-repo-ok">
          {ok}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-pw="add-repo-submit">
        {pending ? "Adding…" : "Add repository"}
      </Button>
    </form>
  );
}
