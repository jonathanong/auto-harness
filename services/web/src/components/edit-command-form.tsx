"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea, WithTooltip } from "@auto-harness/ui";
import type { Command, Provider } from "@auto-harness/shared";

import { apiBase } from "../lib/api.ts";

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `request failed (${res.status})`;
}

export function EditCommandForm({
  command,
  providers,
}: {
  command: Command;
  providers: Provider[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-pw="edit-command-open"
        onClick={() => setOpen(true)}
      >
        Edit command
      </Button>
    );
  }

  return (
    <form
      className="grid max-w-lg gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="form-edit-command"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const name = String(fd.get("name") ?? "").trim();
        const argv = String(fd.get("argv") ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const appendPrompt = fd.get("appendPrompt") === "on";
        const providerId = String(fd.get("providerId") ?? "") || null;
        start(async () => {
          const res = await fetch(
            `${apiBase()}/api/v1/commands/${encodeURIComponent(command.id)}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name, argv, appendPrompt, providerId }),
            },
          );
          if (!res.ok) {
            setError(await errorMessage(res));
            return;
          }
          setOpen(false);
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="name" tip="Display name for this command">
          name
        </Label>
        <Input
          id="name"
          name="name"
          defaultValue={command.name}
          required
          data-pw="edit-command-name"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="argv" tip="One argv element per line — never a shell string">
          argv (one per line)
        </Label>
        <Textarea
          id="argv"
          name="argv"
          required
          rows={4}
          defaultValue={command.argv.join("\n")}
          className="font-mono text-xs"
          data-pw="edit-command-argv"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="appendPrompt"
          defaultChecked={command.appendPrompt}
          data-pw="edit-command-append-prompt"
        />
        append session prompt as the final argv element
      </label>
      <div className="space-y-1">
        <Label
          htmlFor="providerId"
          tip="Standalone commands (none) run ungated on any worktree; provider-owned commands are reached through that provider's accounts"
        >
          provider
        </Label>
        <select
          id="providerId"
          name="providerId"
          defaultValue={command.providerId ?? ""}
          className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
          data-pw="edit-command-provider"
        >
          <option value="">(none — standalone)</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="edit-command-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <WithTooltip tip="Save changes to this command">
          <Button type="submit" size="sm" disabled={pending} data-pw="edit-command-submit">
            {pending ? "Saving…" : "Save"}
          </Button>
        </WithTooltip>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
