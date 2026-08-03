"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

type HostConfigBody = {
  repositories: Array<{
    id: string;
    path: string;
    defaultBranch: string;
    worktrees: Array<{ id: string; path: string; labels: string[] }>;
  }>;
  commandProfiles: Record<string, { argv: string[]; appendPrompt: boolean }>;
};

/**
 * Attach a local git path to this agent and register the repo on the control plane.
 * Agent daemon polls host inventory and re-registers worktrees automatically.
 */
export function AddLocalRepoForm({ agentId }: { agentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setOk(null);
        const fd = new FormData(e.currentTarget);
        const id = String(fd.get("id") ?? "").trim();
        const name = String(fd.get("name") ?? "").trim();
        const path = String(fd.get("path") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
        const worktreeId = String(fd.get("worktreeId") ?? "wt-1").trim() || "wt-1";
        if (!id || !path) {
          setError("id and absolute path are required");
          return;
        }
        const worktreePath = `${path.replace(/\/$/, "")}/.worktrees/${worktreeId}`;

        start(async () => {
          const base = apiBase();
          // 1) Control-plane repository catalog
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
          // 400 = already exists — still attach to agent host inventory

          // 2) Merge into agent host inventory
          let host: HostConfigBody = {
            repositories: [],
            commandProfiles: {
              "echo-prompt": { argv: ["echo"], appendPrompt: true },
            },
          };
          const existing = await fetch(
            `${base}/api/v1/agents/${encodeURIComponent(agentId)}/config`,
          );
          if (existing.ok) {
            const body = (await existing.json()) as HostConfigBody & { agentId?: string };
            host = {
              repositories: body.repositories ?? [],
              commandProfiles:
                body.commandProfiles && Object.keys(body.commandProfiles).length > 0
                  ? body.commandProfiles
                  : host.commandProfiles,
            };
          }
          host.repositories = host.repositories.filter((r) => r.id !== id);
          host.repositories.push({
            id,
            path,
            defaultBranch,
            worktrees: [{ id: worktreeId, path: worktreePath, labels: ["echo"] }],
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
              `Daemon will pick it up within ~15s (or restart agent).`,
          );
          e.currentTarget.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="id">repository id</Label>
        <Input id="id" name="id" required placeholder="demo" defaultValue="demo" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name">display name</Label>
        <Input id="name" name="name" placeholder="Demo" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="path">absolute path on this host</Label>
        <Input id="path" name="path" required placeholder="/Users/you/src/my-repo" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="defaultBranch">default branch</Label>
          <Input id="defaultBranch" name="defaultBranch" defaultValue="main" />
        </div>
        <div className="space-y-1">
          <Label htmlFor="worktreeId">worktree id</Label>
          <Input id="worktreeId" name="worktreeId" defaultValue="wt-1" />
        </div>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {ok ? <p className="text-sm text-emerald-700">{ok}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Registering…" : "Register local repo"}
      </Button>
    </form>
  );
}
