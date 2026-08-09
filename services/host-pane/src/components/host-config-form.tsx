"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Label, Textarea, WithTooltip } from "@auto-harness/ui";

import { apiBase } from "@auto-harness/shared";

export function HostConfigForm({ hostId, initialJson }: { hostId: string; initialJson: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  return (
    <form
      className="space-y-3"
      data-pw="form-host-config-json"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setOk(false);
        const raw = String(new FormData(e.currentTarget).get("configJson") ?? "");
        let body: unknown;
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          setError("Invalid JSON");
          return;
        }
        start(async () => {
          const res = await fetch(
            `${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          if (!res.ok) {
            setError(await res.text());
            return;
          }
          setOk(true);
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="configJson"
          tip="Full host inventory JSON (repositories, worktrees, commandProfiles). Prefer the form UI when possible."
        >
          host config JSON
        </Label>
        <Textarea
          id="configJson"
          name="configJson"
          rows={18}
          required
          defaultValue={initialJson}
          className="font-mono text-xs"
          data-pw="host-config-json"
        />
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="host-config-error">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="text-sm text-emerald-700" data-pw="host-config-ok">
          Saved.
        </p>
      ) : null}
      <WithTooltip tip="Replace the entire host inventory for this hostId">
        <Button type="submit" disabled={pending} data-pw="host-config-submit">
          {pending ? "Saving…" : "Save host config"}
        </Button>
      </WithTooltip>
    </form>
  );
}
