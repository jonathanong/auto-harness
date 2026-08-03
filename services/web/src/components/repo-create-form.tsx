"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

export function RepoCreateForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
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
          e.currentTarget.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="id">id (optional)</Label>
        <Input id="id" name="id" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="name">name</Label>
        <Input id="name" name="name" required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="url">url / path</Label>
        <Input id="url" name="url" required />
      </div>
      <div className="space-y-1">
        <Label htmlFor="defaultBranch">defaultBranch</Label>
        <Input id="defaultBranch" name="defaultBranch" defaultValue="main" />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Create repository"}
      </Button>
    </form>
  );
}
