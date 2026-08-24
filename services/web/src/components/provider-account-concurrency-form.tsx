"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, showToast } from "@auto-harness/ui";
import { apiBase, apiErrorMessage } from "@auto-harness/shared";

type AccountConcurrency = {
  id: string;
  maxConcurrentSessions?: number | null;
};

export function ProviderAccountConcurrencyForm({ account }: { account: AccountConcurrency }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const current = account.maxConcurrentSessions ?? 1;
  if (!editing) {
    return (
      <div className="space-y-1 text-xs" data-pw={`provider-account-concurrency-${account.id}`}>
        <p>
          Max concurrent sessions: <span className="font-mono">{String(current)}</span>
        </p>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setEditing(true)}
          data-pw={`provider-account-concurrency-edit-${account.id}`}
        >
          Edit concurrency
        </Button>
      </div>
    );
  }
  return (
    <form
      className="space-y-1"
      data-pw={`provider-account-concurrency-form-${account.id}`}
      onSubmit={(event) => {
        event.preventDefault();
        const sessions = Number(new FormData(event.currentTarget).get("sessions") ?? 1);
        start(async () => {
          const response = await fetch(
            `${apiBase()}/api/v1/provider-accounts/${encodeURIComponent(account.id)}`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ maxConcurrentSessions: sessions }),
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
        htmlFor={`concurrency-${account.id}`}
        tip="How many sessions may use this account at once. Default 1."
      >
        Max concurrent sessions
      </Label>
      <div className="flex gap-2">
        <Input
          id={`concurrency-${account.id}`}
          name="sessions"
          type="number"
          min={1}
          max={64}
          defaultValue={current}
          className="w-28"
          data-pw={`provider-account-concurrency-input-${account.id}`}
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
