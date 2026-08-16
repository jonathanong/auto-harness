"use client";

import { useRouter } from "next/navigation";
import { mutateInventory, removeHostRepository } from "@auto-harness/shared";

import { ConfirmButton } from "./confirm-button.tsx";

export function RemoveRepoButton({
  hostId,
  repositoryId,
  redirectTo,
  mutate = mutateInventory,
}: {
  hostId: string;
  repositoryId: string;
  /** Navigate here after a successful removal instead of refreshing in place (e.g. the detail page). */
  redirectTo?: string;
  /** Injectable read-modify-write boundary; conditional on the version it reads. */
  mutate?: typeof mutateInventory;
}) {
  const router = useRouter();
  return (
    <ConfirmButton
      triggerLabel="Remove"
      confirmTitle="Remove this repository?"
      confirmDescription="Removes it and its worktrees from host inventory. Does not delete disk files."
      pw={`repo-remove-${repositoryId}`}
      onConfirm={async () => {
        const r = await mutate(hostId, (current) => removeHostRepository(current, repositoryId));
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
