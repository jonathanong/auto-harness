"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { removeHostRepository } from "@auto-harness/shared";
import { Button, WithTooltip } from "@auto-harness/ui";

import { getInventory, putInventory } from "./host-inventory-api.ts";

export function RemoveRepoButton({
  agentId,
  repositoryId,
  redirectTo,
}: {
  agentId: string;
  repositoryId: string;
  /** Navigate here after a successful removal instead of refreshing in place (e.g. the detail page). */
  redirectTo?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip="Remove this repository and its worktrees from host inventory (does not delete disk files)">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        data-pw={`repo-remove-${repositoryId}`}
        onClick={() => {
          start(async () => {
            const current = await getInventory(agentId);
            const next = removeHostRepository(current, repositoryId);
            const r = await putInventory(agentId, next);
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
          });
        }}
      >
        Remove
      </Button>
    </WithTooltip>
  );
}
