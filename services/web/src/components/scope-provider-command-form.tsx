"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";
import {
  getInventory,
  putInventory,
  setScopeProviderCommand,
  type Command,
  type ProviderAccountScope,
} from "@auto-harness/shared";

export function ScopeProviderCommandForm({
  hostId,
  scope,
  providerAccountId,
  currentOverride,
  providerCommands,
}: {
  hostId: string;
  scope: ProviderAccountScope;
  providerAccountId: string;
  /** The raw commandId override set AT THIS scope — undefined means "inherits". */
  currentOverride: string | undefined;
  /** This account's provider's own commands — the sensible choices for an override here. */
  providerCommands: Command[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex items-center gap-2"
      data-pw={`scope-provider-command-form-${providerAccountId}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const value = String(fd.get("commandId") ?? "");
        start(async () => {
          const current = await getInventory(hostId);
          const next = setScopeProviderCommand(
            current,
            scope,
            providerAccountId,
            value || undefined,
          );
          const r = await putInventory(hostId, next);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          router.refresh();
        });
      }}
    >
      <select
        name="commandId"
        defaultValue={currentOverride ?? ""}
        className="flex h-8 rounded-md border border-border bg-background px-2 text-xs"
        data-pw={`scope-provider-command-select-${providerAccountId}`}
      >
        <option value="">(inherit)</option>
        {providerCommands.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {error ? (
        <p
          className="text-xs text-red-700"
          data-pw={`scope-provider-command-error-${providerAccountId}`}
        >
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Override which command this account runs at this scope">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending}
          data-pw={`scope-provider-command-submit-${providerAccountId}`}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </WithTooltip>
    </form>
  );
}
