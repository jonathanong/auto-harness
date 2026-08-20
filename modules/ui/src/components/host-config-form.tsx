"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";
import { Alert } from "./alert.tsx";
import { Button } from "./button.tsx";
import { Label } from "./label.tsx";
import type { RequestFunction } from "./request-types.ts";
import { Textarea } from "./textarea.tsx";
import { WithTooltip } from "./tooltip.tsx";

/**
 * A full-document JSON replace can't be expressed as a mutateInventory() updater (there's no
 * "current inventory" to transform — the user's typed text *is* the whole next document), so
 * this keeps its own read-version-then-PUT path instead. `initialVersion` is the version the
 * displayed `initialJson` was read at; sending it makes the write conditional, and a 409 means
 * someone else saved a change since this page loaded — surfaced as distinct conflict UI rather
 * than folded into the generic error, since blindly retrying would silently reapply this user's
 * possibly-stale full document over the other editor's newer one.
 */
export function HostConfigForm({
  hostId,
  initialJson,
  initialVersion,
  request = fetch,
}: {
  hostId: string;
  initialJson: string;
  initialVersion: number;
  request?: RequestFunction;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [ok, setOk] = useState(false);

  return (
    <form
      className="space-y-3"
      data-pw="form-host-config-json"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setConflict(false);
        setOk(false);
        const raw = String(new FormData(e.currentTarget).get("configJson") ?? "");
        let body: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error("must be a JSON object");
          }
          body = parsed as Record<string, unknown>;
        } catch {
          setError("Invalid JSON");
          return;
        }
        start(async () => {
          const res = await request(
            `${apiBase()}/api/v1/hosts/${encodeURIComponent(hostId)}/inventory`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...body, version: initialVersion }),
            },
          );
          if (!res.ok) {
            if (res.status === 409) {
              setConflict(true);
              return;
            }
            setError(await apiErrorMessage(res));
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
          tip="Full host inventory JSON (repositories, worktrees). Prefer the form UI when possible."
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
      {conflict ? (
        <Alert variant="warning" data-pw="host-config-conflict">
          This host's inventory changed since you loaded this page — reload to see the latest, then
          reapply your edit.
        </Alert>
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
