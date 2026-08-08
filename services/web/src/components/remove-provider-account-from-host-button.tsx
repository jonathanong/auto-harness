"use client";

import { useRouter } from "next/navigation";
import { ConfirmButton } from "@auto-harness/ui";
import { detachProviderAccountFromHost, getInventory, putInventory } from "@auto-harness/shared";

export function RemoveProviderAccountFromHostButton({
  agentId,
  providerAccountId,
  label,
}: {
  agentId: string;
  providerAccountId: string;
  label: string;
}) {
  const router = useRouter();
  return (
    <ConfirmButton
      triggerLabel="Remove"
      confirmTitle={`Detach ${label} from this host?`}
      confirmDescription="Sessions targeting this account will no longer be assignable to worktrees on this host, unless re-attached."
      pw={`host-provider-account-remove-${providerAccountId}`}
      onConfirm={async () => {
        const current = await getInventory(agentId);
        const next = detachProviderAccountFromHost(current, providerAccountId);
        const r = await putInventory(agentId, next);
        if (!r.ok) {
          return;
        }
        router.refresh();
      }}
    />
  );
}
