"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

export function CreateSessionForm({ profiles }: { profiles: string[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="space-y-4"
      data-pw="form-create-session"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const body = {
          repositoryId: String(fd.get("repositoryId") ?? ""),
          prompt: String(fd.get("prompt") ?? ""),
          commandProfile: String(fd.get("commandProfile") ?? ""),
          timeout: Number(fd.get("timeout") ?? 600),
          ref: String(fd.get("ref") ?? "") || undefined,
        };
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          });
          const text = await res.text();
          if (!res.ok) {
            setError(text);
            return;
          }
          let id = "";
          try {
            id = (JSON.parse(text) as { id?: string }).id ?? "";
          } catch {
            /* ignore */
          }
          router.push(id ? `/sessions?q=${encodeURIComponent(id)}` : "/sessions");
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="repositoryId">Repository id</Label>
        <Input
          id="repositoryId"
          name="repositoryId"
          required
          defaultValue="demo"
          data-pw="create-session-repository-id"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="commandProfile">Command profile</Label>
        <select
          id="commandProfile"
          name="commandProfile"
          required
          data-pw="create-session-command-profile"
          className="flex h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          defaultValue={profiles[0] ?? ""}
        >
          {profiles.length === 0 ? (
            <option value="">(no profiles — connect an agent)</option>
          ) : null}
          {profiles.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor="prompt">Prompt</Label>
        <Textarea id="prompt" name="prompt" required rows={4} data-pw="create-session-prompt" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="timeout">Timeout (s)</Label>
          <Input
            id="timeout"
            name="timeout"
            type="number"
            defaultValue={600}
            min={1}
            data-pw="create-session-timeout"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ref">Git ref</Label>
          <Input id="ref" name="ref" placeholder="main" data-pw="create-session-ref" />
        </div>
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="create-session-error">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={pending || profiles.length === 0}
        data-pw="create-session-submit"
      >
        {pending ? "Creating…" : "Create session"}
      </Button>
    </form>
  );
}
