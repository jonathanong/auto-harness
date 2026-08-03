"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { mergeHostRepository, type HostInventory } from "@auto-harness/shared";
import { Button, Input, Label } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

/**
 * Attach a local git path to this agent and register the repo on the control plane.
 * Same outcome as control-pane "Register local repo on an agent".
 */
export function AddLocalRepoForm({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
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
        const worktreeId = String(fd.get("worktreeId") ?? "wt-1").trim() || "wt-1";
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

          let existing: HostInventory | null = null;
          const existingRes = await fetch(
            `${base}/api/v1/agents/${encodeURIComponent(agentId)}/config`,
          );
          if (existingRes.ok) {
            existing = (await existingRes.json()) as HostInventory;
          }
          const host = mergeHostRepository(existing, {
            id,
            path,
            defaultBranch,
            worktreeId,
          });

          const put = await fetch(`${base}/api/v1/agents/${encodeURIComponent(agentId)}/config`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(host),
          });
          if (!put.ok) {
            setError(await put.text());
            return;
          }
          setOk(
            `Registered ${id} on control plane and attached to agent ${agentId}. ` +
              `Daemon picks it up within ~15s.`,
          );
          form.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="id">repository id</Label>
        <Input
          id="id"
          name="id"
          required
          placeholder="demo"
          defaultValue="demo"
          data-pw="add-repo-id"
        />
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
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="defaultBranch">default branch</Label>
          <Input
            id="defaultBranch"
            name="defaultBranch"
            defaultValue="main"
            data-pw="add-repo-branch"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="worktreeId">worktree id</Label>
          <Input
            id="worktreeId"
            name="worktreeId"
            defaultValue="wt-1"
            data-pw="add-repo-worktree-id"
          />
        </div>
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
        {pending ? "Registering…" : "Register local repo"}
      </Button>
    </form>
  );
}
