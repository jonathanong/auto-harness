"use client";

import { useRouter } from "next/navigation";
import { ConfirmButton } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";

export function RemoveProviderAccountButton({
  accountId,
  attachedHostCount,
}: {
  accountId: string;
  attachedHostCount: number;
}) {
  const router = useRouter();
  return (
    <ConfirmButton
      triggerLabel="Remove"
      confirmTitle="Remove this provider account?"
      confirmDescription={
        attachedHostCount > 0
          ? `Attached to ${attachedHostCount} host${attachedHostCount === 1 ? "" : "s"} — removing it from the catalog does not detach it from those hosts, orphaning their attachments.`
          : "Permanently remove this account from the catalog."
      }
      pw={`provider-account-remove-${accountId}`}
      onConfirm={async () => {
        const res = await fetch(
          `${apiBase()}/api/v1/provider-accounts/${encodeURIComponent(accountId)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          return;
        }
        router.refresh();
      }}
    />
  );
}
