"use client";

import { useState } from "react";
import { Button, WithTooltip, showToast } from "@auto-harness/ui";
import { mutateInventory, setHostProviderAccountCommand } from "@auto-harness/shared";
import type { Command } from "@auto-harness/shared";

import { navigateBrowser } from "../lib/browser-navigation.ts";

export function HostProviderAccountCommandForm({
  hostId,
  providerAccountId,
  currentCommandId,
  providerCommands,
  navigate = navigateBrowser,
}: {
  hostId: string;
  providerAccountId: string;
  currentCommandId: string | undefined;
  /** This account's provider's own commands — the sensible choices for a host-level override. */
  providerCommands: Command[];
  navigate?: (href: string) => void;
}) {
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-pw={`host-provider-account-command-form-${providerAccountId}`}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const value = String(fd.get("commandId") ?? "");
        setPending(true);
        void (async () => {
          try {
            const r = await mutateInventory(hostId, (current) =>
              setHostProviderAccountCommand(current, providerAccountId, value || undefined),
            );
            if (!r.ok) {
              showToast(r.error, {
                variant: "destructive",
                pw: `host-provider-account-command-error-${providerAccountId}`,
              });
              return;
            }
            setPending(false);
            navigate(`${location.pathname}${location.search}`);
          } catch (cause) {
            showToast(String(cause), {
              variant: "destructive",
              pw: `host-provider-account-command-error-${providerAccountId}`,
            });
          } finally {
            setPending(false);
          }
        })();
      }}
    >
      <select
        name="commandId"
        defaultValue={currentCommandId ?? ""}
        className="flex h-8 rounded-md border border-border bg-background px-2 text-xs"
        data-pw={`host-provider-account-command-select-${providerAccountId}`}
      >
        <option value="">(inherit provider default)</option>
        {providerCommands.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <WithTooltip tip="Override which command this account runs on this host">
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending}
          data-pw={`host-provider-account-command-submit-${providerAccountId}`}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </WithTooltip>
    </form>
  );
}
