"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, RetryToast } from "@auto-harness/ui";
import { apiBase } from "@auto-harness/shared";

import { deleteCatalogResource } from "./catalog-delete.ts";

export function DeleteWorkspacePoolButton({ poolId }: { poolId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = () => {
    setPending(true);
    void (async () => {
      const failure = await deleteCatalogResource(
        fetch,
        `${apiBase()}/api/v1/workspace-pools/${encodeURIComponent(poolId)}`,
      );
      if (failure) {
        setError(failure);
        setPending(false);
        return;
      }
      router.push("/workspace-pools");
      router.refresh();
    })();
  };
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-pw="delete-workspace-pool-open"
        onClick={() => setConfirming(true)}
      >
        Delete workspace pool
      </Button>
    );
  }
  return (
    <div
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="delete-workspace-pool-confirm"
    >
      <p className="text-sm text-red-700">
        Delete this workspace pool. Attached slots, schedules, or active sessions block deletion.
      </p>
      {error ? (
        <RetryToast onRetry={remove} pending={pending}>
          <p data-pw="delete-workspace-pool-error">{error}</p>
        </RetryToast>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={pending}
          onClick={remove}
          data-pw="delete-workspace-pool-confirm-submit"
        >
          {pending ? "Deleting…" : "Confirm delete"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
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
