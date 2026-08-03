"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

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
        const form = e.currentTarget;
        const fd = new FormData(form);
        const body: Record<string, string> = {
          name: String(fd.get("name") ?? ""),
          url: String(fd.get("url") ?? ""),
          defaultBranch: String(fd.get("defaultBranch") ?? "main"),
        };
        const id = String(fd.get("id") ?? "").trim();
        if (id) {
          body.id = id;
        }
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/repositories`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            setError(await res.text());
            return;
          }
          form.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="id" tip="Optional stable id; auto-generated if omitted">
          id (optional)
        </Label>
        <Input id="id" name="id" data-pw="repo-catalog-id" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name" tip="Human-readable name shown in the control plane">
          name
        </Label>
        <Input id="name" name="name" required data-pw="repo-catalog-name" />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="url"
          tip="Remote URL or logical path stored in the catalog (agent host paths are separate)"
        >
          url / path
        </Label>
        <Input id="url" name="url" required data-pw="repo-catalog-url" />
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
