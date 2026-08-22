"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { apiBase, apiErrorMessage, parseHostInventory } from "@auto-harness/shared";
import { Alert } from "./alert.tsx";
import { Button } from "./button.tsx";
import { Label } from "./label.tsx";
import { JsonEditor } from "./json-editor.tsx";
import type { RequestFunction } from "./request-types.ts";
import { dismissToast, showToast } from "./toast.tsx";
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
  const [conflict, setConflict] = useState(false);
  const [ok, setOk] = useState(false);
  const [raw, setRaw] = useState(initialJson);
  const [validationError, setValidationError] = useState<string | null>(null);
  const savedRefreshVersionRef = useRef<number | null>(null);

  useEffect(() => {
    setRaw(initialJson);
    setConflict(false);
    const preserveSavedFeedback = savedRefreshVersionRef.current === initialVersion;
    savedRefreshVersionRef.current = null;
    if (!preserveSavedFeedback) setOk(false);
  }, [initialJson, initialVersion]);

  return (
    <form
      className="space-y-3"
      data-pw="form-host-config-json"
      onSubmit={(e) => {
        e.preventDefault();
        dismissToast();
        setConflict(false);
        setOk(false);
        let body: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw) as unknown;
          parseHostInventory(parsed);
          body = parsed as Record<string, unknown>;
        } catch {
          showToast("Invalid JSON", { variant: "destructive", pw: "host-config-error" });
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
            showToast(await apiErrorMessage(res), {
              variant: "destructive",
              pw: "host-config-error",
            });
            return;
          }
          savedRefreshVersionRef.current = initialVersion + 1;
          setOk(true);
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label
          id="configJsonLabel"
          tip="Full host inventory JSON (host setup, repositories, worktrees). Prefer the form UI when possible."
        >
          Host Config JSON
        </Label>
        <JsonEditor
          value={raw}
          onChange={setRaw}
          validate={(value) => {
            try {
              parseHostInventory(value);
              return null;
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
          }}
          onValidationChange={setValidationError}
          labelledBy="configJsonLabel"
          pw="host-config-json"
        />
      </div>
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
        <Button
          type="submit"
          disabled={pending || validationError !== null}
          data-pw="host-config-submit"
        >
          {pending ? "Saving…" : "Save host config"}
        </Button>
      </WithTooltip>
    </form>
  );
}
