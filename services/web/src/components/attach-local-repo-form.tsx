"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label } from "@auto-harness/ui";

import { attachLocalRepo } from "../lib/attach-local-repo.ts";

/** Control-plane form: catalog + attach local path to a selected agent. */
export function AttachLocalRepoForm({ agentIds }: { agentIds: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (agentIds.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No agents registered yet. Start <code>pnpm local:agent start</code>, then refresh this page.
      </p>
    );
  }

  return (
    <form
      className="grid max-w-lg gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setOk(null);
        const fd = new FormData(e.currentTarget);
        const agentId = String(fd.get("agentId") ?? "").trim();
        const id = String(fd.get("id") ?? "").trim();
        const name = String(fd.get("name") ?? "").trim();
        const path = String(fd.get("path") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
        const worktreeId = String(fd.get("worktreeId") ?? "wt-1").trim() || "wt-1";
        if (!agentId || !id || !path) {
          setError("agent, id, and absolute path on the agent host are required");
          return;
        }
        start(async () => {
          const result = await attachLocalRepo({
            agentId,
            id,
            name,
            path,
            defaultBranch,
            worktreeId,
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setOk(
            `Registered ${id} and attached to agent ${agentId}. Daemon reloads inventory within ~15s.`,
          );
          e.currentTarget.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="agentId">agent</Label>
        <select
          id="agentId"
          name="agentId"
          required
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          defaultValue={agentIds[0]}
        >
          {agentIds.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="id">repository id</Label>
        <Input id="id" name="id" required defaultValue="demo" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name">display name</Label>
        <Input id="name" name="name" placeholder="Demo" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="path">absolute path on agent host</Label>
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
        {pending ? "Registering…" : "Register local repo on agent"}
      </Button>
    </form>
  );
}
