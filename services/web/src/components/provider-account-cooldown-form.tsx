"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Button,
  Input,
  Label,
  ProviderAccountHealth,
  isProviderAccountPaused,
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
  const [error, setError] = useState<string | null>(null);
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
        setError(null);
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
            setError(await apiErrorMessage(response));
            return;
          }
          setEditing(false);
          router.refresh();
        });
      }}
    >
      <Label
        htmlFor={`cooldown-${account.id}`}
        tip="How long an account remains paused after usage_limit"
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
      {error ? <p className="text-xs text-red-700">{error}</p> : null}
    </form>
  );
}

function ClearCooldownButton({ accountId }: { accountId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending}
        data-pw={`provider-account-cooldown-clear-${accountId}`}
        onClick={() =>
          start(async () => {
            setError(null);
            const response = await fetch(
              `${apiBase()}/api/v1/provider-accounts/${encodeURIComponent(accountId)}/usage-limit`,
              { method: "DELETE" },
            );
            if (!response.ok) {
              setError(await apiErrorMessage(response));
              return;
            }
            router.refresh();
          })
        }
      >
        {pending ? "Clearing…" : "Clear pause"}
      </Button>
      {error ? (
        <span
          className="text-xs text-red-700"
          data-pw={`provider-account-cooldown-clear-error-${accountId}`}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
