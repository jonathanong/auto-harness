"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

export function DeleteRepoButton({
  repositoryId,
  attachedHostCount,
}: {
  repositoryId: string;
  attachedHostCount: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        data-pw="delete-repo-open"
        onClick={() => setConfirming(true)}
      >
        Delete repository
      </Button>
    );
  }

  return (
    <div
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="delete-repo-confirm"
    >
      <p className="text-sm text-red-700">
        {attachedHostCount > 0
          ? `Attached to ${attachedHostCount} host${attachedHostCount === 1 ? "" : "s"} — deleting the catalog entry does not detach it from those hosts, orphaning their attachments.`
          : "Permanently remove this repository from the catalog."}
      </p>
      {error ? (
        <p className="text-sm text-red-700" data-pw="delete-repo-error">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <WithTooltip tip="Permanently delete this catalog repository">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={pending}
            data-pw="delete-repo-confirm-submit"
            onClick={() => {
              setError(null);
              start(async () => {
                const res = await fetch(
                  `${apiBase()}/api/v1/repositories/${encodeURIComponent(repositoryId)}`,
                  { method: "DELETE" },
                );
                if (!res.ok) {
                  setError(await res.text());
                  return;
                }
                router.push("/repositories");
                router.refresh();
              });
            }}
          >
            {pending ? "Deleting…" : "Confirm delete"}
          </Button>
        </WithTooltip>
        <Button type="button" size="sm" variant="outline" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
