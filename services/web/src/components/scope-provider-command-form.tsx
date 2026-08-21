"use client";

import { useState } from "react";
import { Button, WithTooltip, showToast } from "@auto-harness/ui";
import {
  mutateInventory,
  setScopeProviderCommand,
  type Command,
  type ProviderAccountScope,
} from "@auto-harness/shared";

import { navigateBrowser } from "../lib/browser-navigation.ts";

export function ScopeProviderCommandForm({
  hostId,
  scope,
  providerAccountId,
  currentOverride,
  providerCommands,
  navigate = navigateBrowser,
}: {
  hostId: string;
  scope: ProviderAccountScope;
  providerAccountId: string;
  /** The raw commandId override set AT THIS scope — undefined means "inherits". */
  currentOverride: string | undefined;
  /** This account's provider's own commands — the sensible choices for an override here. */
  providerCommands: Command[];
  navigate?: (href: string) => void;
}) {
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex items-center gap-2"
      data-pw={`scope-provider-command-form-${providerAccountId}`}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const value = String(fd.get("commandId") ?? "");
        setPending(true);
        void (async () => {
          try {
            const r = await mutateInventory(hostId, (current) =>
              setScopeProviderCommand(current, scope, providerAccountId, value || undefined),
            );
            if (!r.ok) {
              showToast(r.error, {
                variant: "destructive",
                pw: `scope-provider-command-error-${providerAccountId}`,
              });
              return;
            }
            setPending(false);
            navigate(`${location.pathname}${location.search}`);
          } catch (cause) {
            showToast(String(cause), {
              variant: "destructive",
              pw: `scope-provider-command-error-${providerAccountId}`,
            });
          } finally {
            setPending(false);
          }
        })();
      }}
    >
      <select
        name="commandId"
        defaultValue={currentOverride ?? ""}
        className="flex h-8 rounded-md border border-border bg-background px-2 text-xs"
        data-pw={`scope-provider-command-select-${providerAccountId}`}
      >
        <option value="">(inherit)</option>
        {providerCommands.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <WithTooltip tip="Override which command this account runs at this scope">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending}
          data-pw={`scope-provider-command-submit-${providerAccountId}`}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </WithTooltip>
    </form>
  );
}
