"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `request failed (${res.status})`;
}

export function DeleteCommandButton({
  commandId,
  /** Name of the provider this command is the default for, if any — the backend refuses the
   * delete while this holds, so the UI disables up front rather than surfacing a 409. */
  defaultForProviderName,
}: {
  commandId: string;
  defaultForProviderName?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = Boolean(defaultForProviderName);

  if (!confirming) {
    return (
      <WithTooltip
        tip={
          blocked
            ? `This is provider "${defaultForProviderName}"'s default command — change its default first`
            : "Permanently delete this command"
        }
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={blocked}
          data-pw="delete-command-open"
          onClick={() => setConfirming(true)}
        >
          Delete command
        </Button>
      </WithTooltip>
    );
  }

  return (
    <div
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="delete-command-confirm"
    >
      <p className="text-sm text-red-700">Permanently remove this command from the catalog.</p>
      {error ? (
        <p className="text-sm text-red-700" data-pw="delete-command-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          data-pw="delete-command-confirm-submit"
          onClick={() => {
            setError(null);
            start(async () => {
              const res = await fetch(
                `${apiBase()}/api/v1/commands/${encodeURIComponent(commandId)}`,
                { method: "DELETE" },
              );
              if (!res.ok) {
                setError(await errorMessage(res));
                return;
              }
              router.push("/commands");
              router.refresh();
            });
          }}
        >
          {pending ? "Deleting…" : "Confirm delete"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
