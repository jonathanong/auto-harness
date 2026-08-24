"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Button, Input, Label, WithTooltip, showToast } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export function AddProviderAccountForm({ providerId }: { providerId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      data-pw="form-add-provider-account"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        const label = String(fd.get("label") ?? "").trim();
        const usageLimitCooldownSeconds = Number(fd.get("usageLimitCooldownSeconds") ?? 18000);
        const maxConcurrentSessions = Number(fd.get("maxConcurrentSessions") ?? 1);
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/provider-accounts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              providerId,
              label,
              usageLimitCooldownSeconds,
              maxConcurrentSessions,
            }),
          });
          if (!res.ok) {
            showToast(await apiErrorMessage(res), {
              variant: "destructive",
              pw: "provider-account-error",
            });
            return;
          }
          form.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="label" tip="Human-readable identifier for this account, e.g. an email">
          Label
        </Label>
        <Input
          id="label"
          name="label"
          required
          placeholder="you@example.com"
          data-pw="provider-account-label"
        />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="usageLimitCooldownSeconds"
          tip="Pause this account on usage_limit (default 18000s / 5 hours). Not a general retry."
        >
          Cooldown (s)
        </Label>
        <Input
          id="usageLimitCooldownSeconds"
          name="usageLimitCooldownSeconds"
          type="number"
          min={1}
          defaultValue={18000}
          data-pw="provider-account-cooldown-seconds"
        />
        <p className="max-w-xs text-xs text-muted-foreground">
          Pause this account on usage_limit (default 18000s / 5 hours). Not a general retry.
        </p>
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="maxConcurrentSessions"
          tip="How many sessions may use this account at once. Default 1."
        >
          Max concurrent sessions
        </Label>
        <Input
          id="maxConcurrentSessions"
          name="maxConcurrentSessions"
          type="number"
          min={1}
          max={64}
          defaultValue={1}
          data-pw="provider-account-max-concurrent-sessions"
        />
      </div>
      <WithTooltip tip="Add an account of this provider to the catalog">
        <Button type="submit" size="sm" disabled={pending} data-pw="provider-account-submit">
          {pending ? "Saving…" : "Add account"}
        </Button>
      </WithTooltip>
    </form>
  );
}
