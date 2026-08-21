"use client";

import { useState } from "react";
import { Button, WithTooltip, showToast } from "@auto-harness/ui";
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

  return (
    <form
      className="flex items-center gap-2"
      data-pw={`scope-provider-enabled-form-${providerAccountId}`}
      onSubmit={(e) => {
        e.preventDefault();
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
              showToast(r.error, {
                variant: "destructive",
                pw: `scope-provider-enabled-error-${providerAccountId}`,
              });
              return;
            }
            setPending(false);
            navigate(`${location.pathname}${location.search}`);
          } catch (cause) {
            showToast(String(cause), {
              variant: "destructive",
              pw: `scope-provider-enabled-error-${providerAccountId}`,
            });
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
