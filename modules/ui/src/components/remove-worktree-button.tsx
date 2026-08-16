"use client";

import { useRouter } from "next/navigation";
import { mutateInventory, removeHostWorktree } from "@auto-harness/shared";

import { ConfirmButton } from "./confirm-button.tsx";

export function RemoveWorktreeButton({
  hostId,
  repositoryId,
  worktreeId,
  redirectTo,
  mutate = mutateInventory,
}: {
  hostId: string;
  repositoryId: string;
  worktreeId: string;
  /** Navigate here after a successful removal instead of refreshing in place (e.g. the detail page). */
  redirectTo?: string;
  /** Injectable read-modify-write boundary; conditional on the version it reads. */
  mutate?: typeof mutateInventory;
}) {
  const router = useRouter();
  return (
    <ConfirmButton
      triggerLabel="Remove"
      confirmTitle="Remove this worktree?"
      confirmDescription="Removes it from host inventory. Does not delete disk files."
      pw={`worktree-remove-${worktreeId}`}
      onConfirm={async () => {
        const r = await mutate(hostId, (current) =>
          removeHostWorktree(current, repositoryId, worktreeId),
        );
        if (!r.ok) {
          return;
        }
        if (redirectTo) {
          // push() alone can serve a stale client-router-cache snapshot of the
          // target route if it was refreshed earlier in this session — force a
          // fresh fetch too.
          router.push(redirectTo);
          router.refresh();
        } else {
          router.refresh();
        }
      }}
    />
  );
}
