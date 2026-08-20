"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Label, WithTooltip } from "@auto-harness/ui";
import type { Command } from "@auto-harness/shared";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export function ProviderDefaultCommandForm({
  providerId,
  defaultCommandId,
  commands,
}: {
  providerId: string;
  defaultCommandId: string | null;
  /** This provider's own commands — the only valid choices for its default. */
  commands: Command[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-pw="form-provider-default-command"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const value = String(fd.get("defaultCommandId") ?? "");
        start(async () => {
          const res = await fetch(
            `${apiBase()}/api/v1/providers/${encodeURIComponent(providerId)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ defaultCommandId: value || null }),
            },
          );
          if (!res.ok) {
            setError(await apiErrorMessage(res));
            return;
          }
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="defaultCommandId"
          tip="Command used when a provider account has no command override anywhere in the cascade"
        >
          default command
        </Label>
        <select
          id="defaultCommandId"
          name="defaultCommandId"
          defaultValue={defaultCommandId ?? ""}
          className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
          data-pw="provider-default-command-select"
        >
          <option value="">(none)</option>
          {commands.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="provider-default-command-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Save this provider's default command">
        <Button
          type="submit"
          size="sm"
          disabled={pending}
          data-pw="provider-default-command-submit"
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </WithTooltip>
    </form>
  );
}
