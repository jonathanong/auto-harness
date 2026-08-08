"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";
import {
  getInventory,
  putInventory,
  setScopeProviderEnabled,
  type ProviderAccountScope,
} from "@auto-harness/shared";

export function ScopeProviderEnabledForm({
  hostId,
  scope,
  providerAccountId,
  currentOverride,
  inheritedLabel,
}: {
  hostId: string;
  scope: ProviderAccountScope;
  providerAccountId: string;
  /** The raw override value set AT THIS scope — undefined means "inherits". */
  currentOverride: boolean | undefined;
  /** Where an unset value inherits from, for the "(inherit from …)" option label. */
  inheritedLabel: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex items-center gap-2"
      data-pw={`scope-provider-enabled-form-${providerAccountId}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const value = String(fd.get("enabled") ?? "");
        const enabled = value === "" ? undefined : value === "true";
        start(async () => {
          const current = await getInventory(hostId);
          const next = setScopeProviderEnabled(current, scope, providerAccountId, enabled);
          const r = await putInventory(hostId, next);
          if (!r.ok) {
            setError(r.error);
            return;
          }
          router.refresh();
        });
      }}
    >
      <select
        name="enabled"
        defaultValue={currentOverride === undefined ? "" : String(currentOverride)}
        className="flex h-8 rounded-md border border-border bg-background px-2 text-xs"
        data-pw={`scope-provider-enabled-select-${providerAccountId}`}
      >
        <option value="">(inherit from {inheritedLabel})</option>
        <option value="true">Enabled</option>
        <option value="false">Disabled</option>
      </select>
      {error ? (
        <p
          className="text-xs text-red-700"
          data-pw={`scope-provider-enabled-error-${providerAccountId}`}
        >
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Override this account's enablement at this scope">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending}
          data-pw={`scope-provider-enabled-submit-${providerAccountId}`}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </WithTooltip>
    </form>
  );
}
