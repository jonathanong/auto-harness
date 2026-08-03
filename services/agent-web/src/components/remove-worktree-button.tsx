"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { removeHostWorktree, type HostInventory } from "@auto-harness/shared";
import { Button, WithTooltip } from "@auto-harness/ui";

import { putInventory } from "./host-inventory-api.ts";

export function RemoveWorktreeButton({
  agentId,
  inventory,
  repositoryId,
  worktreeId,
  redirectTo,
}: {
  agentId: string;
  inventory: HostInventory;
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
            const next = removeHostWorktree(inventory, repositoryId, worktreeId);
            const r = await putInventory(agentId, next);
            if (!r.ok) {
              return;
            }
            if (redirectTo) {
              router.push(redirectTo);
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
