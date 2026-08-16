"use client";

import { useState } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";
import {
  mutateInventory,
  setScopeProviderEnabled,
  type ProviderAccountScope,
} from "@auto-harness/shared";

import { navigateBrowser } from "../lib/browser-navigation.ts";

export function ScopeProviderEnabledForm({
  hostId,
  scope,
  providerAccountId,
  currentOverride,
  inheritedLabel,
  navigate = navigateBrowser,
}: {
  hostId: string;
  scope: ProviderAccountScope;
  providerAccountId: string;
  /** The raw override value set AT THIS scope — undefined means "inherits". */
  currentOverride: boolean | undefined;
  /** Where an unset value inherits from, for the "(inherit from …)" option label. */
  inheritedLabel: string;
  navigate?: (href: string) => void;
}) {
  const [pending, setPending] = useState(false);
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
        setPending(true);
        void (async () => {
          try {
            const r = await mutateInventory(hostId, (current) =>
              setScopeProviderEnabled(current, scope, providerAccountId, enabled),
            );
            if (!r.ok) {
              setError(r.error);
              return;
            }
            setPending(false);
            navigate(`${location.pathname}${location.search}`);
          } catch (cause) {
            setError(String(cause));
          } finally {
            setPending(false);
          }
        })();
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
