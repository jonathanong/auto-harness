"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Button,
  Input,
  Label,
  ProviderAccountHealth,
  isProviderAccountPaused,
  showToast,
} from "@auto-harness/ui";
import { apiBase, apiErrorMessage } from "@auto-harness/shared";

type AccountCooldown = {
  id: string;
  usageLimitCooldownSeconds?: number | null;
  usageLimitedUntil?: string | null;
  lastUsageLimitedAt?: string | null;
};

export function ProviderAccountCooldownForm({ account }: { account: AccountCooldown }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const paused = isProviderAccountPaused(account.usageLimitedUntil);
  if (!editing) {
    return (
      <div className="space-y-1 text-xs" data-pw={`provider-account-cooldown-${account.id}`}>
        <ProviderAccountHealth
          usageLimitedUntil={account.usageLimitedUntil}
          usageLimitCooldownSeconds={account.usageLimitCooldownSeconds ?? 18000}
          lastUsageLimitedAt={account.lastUsageLimitedAt}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            data-pw={`provider-account-cooldown-edit-${account.id}`}
          >
            Edit cooldown
          </Button>
          {paused ? <ClearCooldownButton accountId={account.id} /> : null}
        </div>
      </div>
    );
  }
  return (
    <form
      className="space-y-1"
      data-pw={`provider-account-cooldown-form-${account.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        const seconds = Number(new FormData(event.currentTarget).get("seconds") ?? 18000);
        start(async () => {
          const response = await fetch(
            `${apiBase()}/api/v1/provider-accounts/${encodeURIComponent(account.id)}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ usageLimitCooldownSeconds: seconds }),
            },
          );
          if (!response.ok) {
            showToast(await apiErrorMessage(response), { variant: "destructive" });
            return;
          }
          setEditing(false);
          router.refresh();
        });
      }}
    >
      <Label
        htmlFor={`cooldown-${account.id}`}
        tip="Pause this account on usage_limit (default 18000s / 5 hours). Not a general retry."
      >
        Cooldown (s)
      </Label>
      <div className="flex gap-2">
        <Input
          id={`cooldown-${account.id}`}
          name="seconds"
          type="number"
          min={1}
          defaultValue={account.usageLimitCooldownSeconds ?? 18000}
          className="w-28"
          data-pw={`provider-account-cooldown-input-${account.id}`}
        />
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ClearCooldownButton({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      data-pw={`provider-account-cooldown-clear-${accountId}`}
      onClick={() =>
        start(async () => {
          const response = await fetch(
            `${apiBase()}/api/v1/provider-accounts/${encodeURIComponent(accountId)}/usage-limit`,
            { method: "DELETE" },
          );
          if (!response.ok) {
            showToast(await apiErrorMessage(response), {
              variant: "destructive",
              pw: `provider-account-cooldown-clear-error-${accountId}`,
            });
            return;
          }
          router.refresh();
        })
      }
    >
      {pending ? "Clearing…" : "Clear pause"}
    </Button>
  );
}
