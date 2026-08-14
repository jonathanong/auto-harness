"use client";

import { useState } from "react";
import { Button, RetryToast, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";
import { navigateBrowser } from "../lib/browser-navigation.ts";
import { deleteCatalogResource } from "./catalog-delete.ts";
import type { RequestFunction } from "./request-types.ts";

export function DeleteCommandButton({
  commandId,
  /** Name of the provider this command is the default for, if any — the backend refuses the
   * delete while this holds, so the UI disables up front rather than surfacing a 409. */
  defaultForProviderName,
  request = fetch,
  navigate = navigateBrowser,
}: {
  commandId: string;
  defaultForProviderName?: string;
  request?: RequestFunction;
  navigate?: (href: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = Boolean(defaultForProviderName);
  const deleteCommand = () => {
    setPending(true);
    void (async () => {
      const failure = await deleteCatalogResource(
        request,
        `${apiBase()}/api/v1/commands/${encodeURIComponent(commandId)}`,
      );
      if (failure) {
        setError(failure);
        setPending(false);
        return;
      }
      setPending(false);
      navigate("/commands");
    })();
  };

  if (!confirming) {
    return (
      <WithTooltip
        tip={
          blocked
            ? `This is provider "${defaultForProviderName}"'s default command — change its default first`
            : "Permanently delete this command"
        }
      >
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={blocked}
          data-pw="delete-command-open"
          onClick={() => setConfirming(true)}
        >
          Delete command
        </Button>
      </WithTooltip>
    );
  }

  return (
    <div
      className="grid gap-2 rounded-md border border-dashed border-border p-3"
      data-pw="delete-command-confirm"
    >
      <p className="text-sm text-red-700">Permanently remove this command from the catalog.</p>
      {error ? (
        <RetryToast onRetry={deleteCommand} pending={pending}>
          <p data-pw="delete-command-error">{error}</p>
        </RetryToast>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={pending}
          data-pw="delete-command-confirm-submit"
          onClick={deleteCommand}
        >
          {pending ? "Deleting…" : "Confirm delete"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            setError(null);
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
