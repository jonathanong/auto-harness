"use client";

import { useState } from "react";
import { Button, WithTooltip } from "@auto-harness/ui";
import { getInventory, putInventory, setHostProviderAccountCommand } from "@auto-harness/shared";
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
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex flex-wrap items-center gap-2"
      data-pw={`host-provider-account-command-form-${providerAccountId}`}
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const value = String(fd.get("commandId") ?? "");
        setPending(true);
        void (async () => {
          try {
            const current = await getInventory(hostId);
            const next = setHostProviderAccountCommand(
              current,
              providerAccountId,
              value || undefined,
            );
            const r = await putInventory(hostId, next);
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
      {error ? (
        <p
          className="text-xs text-red-700"
          data-pw={`host-provider-account-command-error-${providerAccountId}`}
        >
          {error}
        </p>
      ) : null}
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
