"use client";

import { useRouter } from "next/navigation";
import { getInventory, putInventory, removeHostWorktree } from "@auto-harness/shared";

import { ConfirmButton } from "./confirm-button.tsx";

export function RemoveWorktreeButton({
  hostId,
  repositoryId,
  worktreeId,
  redirectTo,
  readInventory = getInventory,
  writeInventory = putInventory,
}: {
  hostId: string;
  repositoryId: string;
  worktreeId: string;
  /** Navigate here after a successful removal instead of refreshing in place (e.g. the detail page). */
  redirectTo?: string;
  readInventory?: typeof getInventory;
  writeInventory?: typeof putInventory;
}) {
  const router = useRouter();
  return (
    <ConfirmButton
      triggerLabel="Remove"
      confirmTitle="Remove this worktree?"
      confirmDescription="Removes it from host inventory. Does not delete disk files."
      pw={`worktree-remove-${worktreeId}`}
      onConfirm={async () => {
        const current = await readInventory(hostId);
        const next = removeHostWorktree(current, repositoryId, worktreeId);
        const r = await writeInventory(hostId, next);
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
