"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { putInventory, removeCommandProfile, type HostInventory } from "@auto-harness/shared";
import { Button, WithTooltip } from "@auto-harness/ui";

export function RemoveCommandProfileButton({
  agentId,
  inventory,
  name,
}: {
  agentId: string;
  inventory: HostInventory;
  name: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <WithTooltip tip="Remove this command profile from host inventory">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        data-pw={`profile-remove-${name}`}
        onClick={() => {
          start(async () => {
            const next = removeCommandProfile(inventory, name);
            const r = await putInventory(agentId, next);
            if (!r.ok) {
              return;
            }
            router.refresh();
          });
        }}
      >
        Remove
      </Button>
    </WithTooltip>
  );
}
