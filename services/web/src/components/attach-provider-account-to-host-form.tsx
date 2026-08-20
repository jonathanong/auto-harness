"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, Label, WithTooltip, showToast } from "@auto-harness/ui";
import { attachProviderAccountToHost, mutateInventory } from "@auto-harness/shared";

export function AttachProviderAccountToHostForm({
  hostId,
  availableAccounts,
}: {
  hostId: string;
  /** Catalog accounts not yet attached to this host, pre-labeled `<provider> — <account label>`. */
  availableAccounts: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();

  if (availableAccounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Every catalog provider account is already attached to this host.
      </p>
    );
  }

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-pw="form-attach-provider-account"
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const providerAccountId = String(fd.get("providerAccountId") ?? "");
        start(async () => {
          const r = await mutateInventory(hostId, (current) =>
            attachProviderAccountToHost(current, { providerAccountId }),
          );
          if (!r.ok) {
            showToast(r.error, { variant: "destructive", pw: "attach-provider-account-error" });
            return;
          }
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="providerAccountId"
          tip="Makes this account eligible for sessions on this host"
        >
          Provider Account
        </Label>
        <select
          id="providerAccountId"
          name="providerAccountId"
          defaultValue={availableAccounts[0]!.id}
          className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
          data-pw="attach-provider-account-select"
        >
          {availableAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <WithTooltip tip="Attach this provider account to the host">
        <Button type="submit" size="sm" disabled={pending} data-pw="attach-provider-account-submit">
          {pending ? "Saving…" : "Attach"}
        </Button>
      </WithTooltip>
    </form>
  );
}
