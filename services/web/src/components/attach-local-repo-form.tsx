"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label } from "@auto-harness/ui";

import { attachLocalRepo } from "../lib/attach-local-repo.ts";

/** Control-plane form: catalog + attach local path to a selected agent (no auto worktree). */
export function AttachLocalRepoForm({ agentIds }: { agentIds: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (agentIds.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No agents yet. Use <strong>Add agent</strong> on the Agents page, or start{" "}
        <code>pnpm local:agent start</code>, then refresh.
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
        setOk(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const agentId = String(fd.get("agentId") ?? "").trim();
        const id = String(fd.get("id") ?? "").trim();
        const name = String(fd.get("name") ?? "").trim();
        const path = String(fd.get("path") ?? "").trim();
        const defaultBranch = String(fd.get("defaultBranch") ?? "main").trim() || "main";
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
          });
          if (!result.ok) {
            setError(result.error);
            return;
          }
          setOk(
            `Registered ${id} on agent ${agentId} with no worktrees. Add worktrees on the agent pane Host config.`,
          );
          form.reset();
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
          data-pw="attach-repo-agent-id"
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
        <Input id="id" name="id" required defaultValue="demo" data-pw="attach-repo-id" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name">display name</Label>
        <Input id="name" name="name" placeholder="Demo" data-pw="attach-repo-name" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="path">absolute path on agent host</Label>
        <Input
          id="path"
          name="path"
          required
          placeholder="/Users/you/src/my-repo"
          data-pw="attach-repo-path"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch">default branch</Label>
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
      {ok ? (
        <p className="text-sm text-emerald-700" data-pw="attach-repo-ok">
          {ok}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-pw="attach-repo-submit">
        {pending ? "Registering…" : "Register local repo on agent"}
      </Button>
    </form>
  );
}
