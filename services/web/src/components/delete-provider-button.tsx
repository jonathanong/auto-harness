"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `request failed (${res.status})`;
}

export function DeleteProviderButton({
  providerId,
  accountCount,
  commandCount,
}: {
  providerId: string;
  accountCount: number;
  commandCount: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = accountCount > 0 || commandCount > 0;

  if (!confirming) {
    return (
      <WithTooltip
        tip={
          blocked
            ? "Remove all accounts and commands (including the default) before deleting a provider"
            : "Permanently delete this provider"
        }
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={blocked}
          data-pw="delete-provider-open"
          onClick={() => setConfirming(true)}
        >
          Delete provider
        </Button>
      </WithTooltip>
    );
  }

  return (
    <div
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="delete-provider-confirm"
    >
      <p className="text-sm text-red-700">Permanently remove this provider from the catalog.</p>
      {error ? (
        <p className="text-sm text-red-700" data-pw="delete-provider-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          data-pw="delete-provider-confirm-submit"
          onClick={() => {
            setError(null);
            start(async () => {
              const res = await fetch(
                `${apiBase()}/api/v1/providers/${encodeURIComponent(providerId)}`,
                { method: "DELETE" },
              );
              if (!res.ok) {
                setError(await errorMessage(res));
                return;
              }
              router.push("/providers");
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
