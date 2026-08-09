"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `request failed (${res.status})`;
}

export function AddProviderAccountForm({ providerId }: { providerId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-pw="form-add-provider-account"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const label = String(fd.get("label") ?? "").trim();
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/provider-accounts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ providerId, label }),
          });
          if (!res.ok) {
            setError(await errorMessage(res));
            return;
          }
          form.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="label" tip="Human-readable identifier for this account, e.g. an email">
          label
        </Label>
        <Input
          id="label"
          name="label"
          required
          placeholder="jonathanrichardong@gmail.com"
          data-pw="provider-account-label"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="provider-account-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Add an account of this provider to the catalog">
        <Button type="submit" size="sm" disabled={pending} data-pw="provider-account-submit">
          {pending ? "Saving…" : "Add account"}
        </Button>
      </WithTooltip>
    </form>
  );
}
