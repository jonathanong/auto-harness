"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { flushSync } from "react-dom";
import { emptyHostInventory } from "@auto-harness/shared";
import { Button, Input, Label, WithTooltip, withToast } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

/** Control-plane: seed a host inventory slot (the host's daemon may be offline). */
export function AddHostForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-add-host"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setOk(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const hostId = String(fd.get("hostId") ?? "").trim();
        if (!hostId) {
          setError("hostId is required");
          return;
        }
        setPending(true);
        void (async () => {
          try {
            const existing = await fetch(
              `${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
              { cache: "no-store" },
            );
            if (existing.ok) {
              setOk(`Host slot ${hostId} already exists — left its inventory untouched.`);
              form.reset();
              setPending(false);
              router.refresh();
              return;
            }
            const res = await fetch(
              `${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
              {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(emptyHostInventory()),
              },
            );
            if (!res.ok) {
              setError(
                res.status === 403
                  ? "Admins create host slots; operators run sessions."
                  : await apiErrorMessage(res),
              );
              setPending(false);
              return;
            }
            flushSync(() => {
              // Connect instructions live on the host's own page (see ConnectHostPanel), not
              // here: this message is about to be replaced by the navigation below, so a
              // command shown only in this paragraph would rarely be visible long enough to
              // read or copy.
              setOk(`Host slot ${hostId} created (empty inventory).`);
              form.reset();
            });
            // Stays disabled through the navigation below to prevent a double-submit — the
            // page is about to be replaced, so there's no "stuck" state for the user to see.
            router.replace(
              withToast(`/hosts/${encodeURIComponent(hostId)}`, `Host slot ${hostId} created.`),
            );
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            setPending(false);
          }
        })();
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="hostId"
          tip="Stable host identity. Must match HARNESS_HOST_ID on the host when you start the daemon. Does not start a process."
        >
          hostId
        </Label>
        <Input id="hostId" name="hostId" required placeholder="local-1" data-pw="add-host-id" />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="add-host-error">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="text-sm text-emerald-700" data-pw="add-host-ok">
          {ok}
        </p>
      ) : null}
      <WithTooltip tip="Creates empty host inventory on the control plane so you can attach repos before the daemon is online">
        <Button type="submit" disabled={pending} data-pw="add-host-submit">
          {pending ? "Creating…" : "Add host"}
        </Button>
      </WithTooltip>
    </form>
  );
}
