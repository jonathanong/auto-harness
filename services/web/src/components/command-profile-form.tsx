"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { putInventory, setCommandProfile, type HostInventory } from "@auto-harness/shared";
import { Button, Input, Label, Textarea, WithTooltip } from "@auto-harness/ui";

export function CommandProfileForm({
  agentId,
  inventory,
  existingName,
}: {
  agentId: string;
  inventory: HostInventory;
  /** When set, edits this existing profile (name field becomes read-only). */
  existingName?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(Boolean(existingName));
  const [error, setError] = useState<string | null>(null);
  const existing = existingName ? inventory.commandProfiles[existingName] : undefined;

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-pw="add-profile-open"
        onClick={() => setOpen(true)}
      >
        + Add command profile
      </Button>
    );
  }

  return (
    <form
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw={existingName ? `form-edit-profile-${existingName}` : "form-add-profile"}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const name = (existingName ?? String(fd.get("name") ?? "")).trim();
        const argv = String(fd.get("argv") ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const appendPrompt = fd.get("appendPrompt") === "on";
        if (!name || argv.length === 0) {
          setError("name and at least one argv line are required");
          return;
        }
        start(async () => {
          const next = setCommandProfile(inventory, name, { argv, appendPrompt });
          const r = await putInventory(agentId, next);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          if (!existingName) {
            setOpen(false);
          }
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="name" tip="Profile name referenced by sessions">
          name
        </Label>
        <Input
          id="name"
          name="name"
          required
          disabled={Boolean(existingName)}
          defaultValue={existingName}
          placeholder="claude-default"
          data-pw="profile-name"
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
          defaultValue={(existing?.argv ?? []).join("\n")}
          className="font-mono text-xs"
          data-pw="profile-argv"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="appendPrompt"
          defaultChecked={existing?.appendPrompt ?? true}
          data-pw="profile-append-prompt"
        />
        append session prompt as the final argv element
      </label>
      {error ? (
        <p className="text-sm text-red-700" data-pw="profile-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <WithTooltip tip="Persist this command profile on host inventory">
          <Button type="submit" size="sm" disabled={pending} data-pw="profile-submit">
            {pending ? "Saving…" : "Save"}
          </Button>
        </WithTooltip>
        {existingName ? null : (
          <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
