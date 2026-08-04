"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { getInventory, putInventory, removeHostWorktree } from "@auto-harness/shared";

import { Button } from "./button.tsx";
import { WithTooltip } from "./tooltip.tsx";

export function RemoveWorktreeButton({
  agentId,
  repositoryId,
  worktreeId,
  redirectTo,
}: {
  agentId: string;
  repositoryId: string;
  worktreeId: string;
  /** Navigate here after a successful removal instead of refreshing in place (e.g. the detail page). */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip="Remove this worktree from host inventory (does not delete disk files)">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        data-pw={`worktree-remove-${worktreeId}`}
        onClick={() => {
          start(async () => {
            const current = await getInventory(agentId);
            const next = removeHostWorktree(current, repositoryId, worktreeId);
            const r = await putInventory(agentId, next);
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
          });
        }}
      >
        Remove
      </Button>
    </WithTooltip>
  );
}
