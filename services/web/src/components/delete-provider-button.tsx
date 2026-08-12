"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, RetryToast, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";
import { deleteCatalogResource } from "./catalog-delete.ts";
import type { RequestFunction } from "./request-types.ts";

export function DeleteProviderButton({
  providerId,
  accountCount,
  commandCount,
  request = fetch,
}: {
  providerId: string;
  accountCount: number;
  commandCount: number;
  request?: RequestFunction;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = accountCount > 0 || commandCount > 0;
  const deleteProvider = () => {
    start(async () => {
      const failure = await deleteCatalogResource(
        request,
        `${apiBase()}/api/v1/providers/${encodeURIComponent(providerId)}`,
      );
      if (failure) {
        setError(failure);
        return;
      }
      router.push("/providers");
      router.refresh();
    });
  };

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
        <RetryToast onRetry={deleteProvider} pending={pending}>
          <p data-pw="delete-provider-error">{error}</p>
        </RetryToast>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          data-pw="delete-provider-confirm-submit"
          onClick={deleteProvider}
        >
          {pending ? "Deleting…" : "Confirm delete"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setError(null);
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
