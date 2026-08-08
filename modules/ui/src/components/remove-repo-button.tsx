"use client";

import { useRouter } from "next/navigation";
import { getInventory, putInventory, removeHostRepository } from "@auto-harness/shared";

import { ConfirmButton } from "./confirm-button.tsx";

export function RemoveRepoButton({
  hostId,
  repositoryId,
  redirectTo,
}: {
  hostId: string;
  repositoryId: string;
  /** Navigate here after a successful removal instead of refreshing in place (e.g. the detail page). */
  redirectTo?: string;
}) {
  const router = useRouter();
  return (
    <ConfirmButton
      triggerLabel="Remove"
      confirmTitle="Remove this repository?"
      confirmDescription="Removes it and its worktrees from host inventory. Does not delete disk files."
      pw={`repo-remove-${repositoryId}`}
      onConfirm={async () => {
        const current = await getInventory(hostId);
        const next = removeHostRepository(current, repositoryId);
        const r = await putInventory(hostId, next);
        if (!r.ok) {
          return;
        }
        if (redirectTo) {
          // push() alone can serve a stale client-router-cache snapshot of the
          // target route if it was refreshed earlier in this session (e.g. by
          // the add-repository flow) — force a fresh fetch too.
          router.push(redirectTo);
          router.refresh();
        } else {
          router.refresh();
        }
      }}
    />
  );
}
