"use client";

import { useRouter } from "next/navigation";
import { ConfirmButton } from "@auto-harness/ui";
import { detachProviderAccountFromHost, mutateInventory } from "@auto-harness/shared";

export function RemoveProviderAccountFromHostButton({
  hostId,
  providerAccountId,
  label,
}: {
  hostId: string;
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
        const r = await mutateInventory(hostId, (current) =>
          detachProviderAccountFromHost(current, providerAccountId),
        );
        if (!r.ok) {
          return { ok: false, error: r.error || "request failed while updating host inventory" };
        }
        router.refresh();
      }}
    />
  );
}
