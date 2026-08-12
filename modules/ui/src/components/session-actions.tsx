"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "./button.tsx";
import { ConfirmButton } from "./confirm-button.tsx";
import { WithTooltip } from "./tooltip.tsx";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export type SessionActionsProps = {
  sessionId: string;
  status: string;
  /** Where a successful resume navigates (a new session id is appended). Default "/sessions". */
  detailHrefBase?: string;
  /** Control-plane-only New Session URL used to edit replayable fields before creating a clone. */
  cloneEditHref?: string;
  /** The assigned host is known to be offline, so cancellation needs an explicit warning. */
  assignedHostOffline?: boolean;
};

/** Cancel/resume/archive — pure REST against the same-origin `/api/v1` proxy, no app wiring needed. */
export function SessionActions({
  sessionId,
  status,
  detailHrefBase = "/sessions",
  cloneEditHref,
  assignedHostOffline = false,
}: SessionActionsProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [action, setAction] = useState<"cancel" | "resume" | "clone" | "archive" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const request = async (
    which: "cancel" | "resume" | "clone" | "archive",
    path: string,
  ): Promise<void | { ok: false; error: string }> => {
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/${path}`, {
      method: "POST",
    });
    if (!res.ok) {
      const message = await res.text();
      setError(message);
      return { ok: false, error: message };
    }
    if (which === "resume" || which === "clone") {
      const body = (await res.json()) as { id?: string };
      if (body.id) {
        router.push(`${detailHrefBase}/${encodeURIComponent(body.id)}`);
        return;
      }
    }
    router.refresh();
  };

  const run = (which: "cancel" | "resume" | "clone" | "archive", path: string) => {
    setError(null);
    setAction(which);
    start(async () => {
      await request(which, path);
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {status === "running" && assignedHostOffline ? (
          <ConfirmButton
            triggerLabel="Force-cancel"
            confirmTitle="Force-cancel this session?"
            confirmDescription="This marks the session cancelled in the control plane. The disconnected agent cannot confirm that its remote process stopped, and the worktree remains reserved for safe reconciliation."
            confirmLabel="Force-cancel"
            onConfirm={() => {
              setError(null);
              setAction("cancel");
              return request("cancel", "cancel");
            }}
            pw="session-force-cancel"
            variant="destructive"
            disabled={pending}
          />
        ) : ACTIVE_STATUSES.has(status) ? (
          <WithTooltip tip="Cancel this session — running work finishes stopping, worktree is released">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              aria-busy={pending && action === "cancel"}
              data-pw="session-cancel"
              onClick={() => void run("cancel", "cancel")}
            >
              {pending && action === "cancel" ? "Cancelling…" : "Cancel session"}
            </Button>
          </WithTooltip>
        ) : null}
        {TERMINAL_STATUSES.has(status) ? (
          <>
            <WithTooltip tip="Create a new session pinned to the same host, resuming from here">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                aria-busy={pending && action === "resume"}
                data-pw="session-resume"
                onClick={() => void run("resume", "resume")}
              >
                {pending && action === "resume" ? "Resuming…" : "Resume"}
              </Button>
            </WithTooltip>
            <WithTooltip tip="Create a clean independent rerun of this session">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending}
                aria-busy={pending && action === "clone"}
                data-pw="session-clone"
                onClick={() => void run("clone", "clone")}
              >
                {pending && action === "clone" ? "Re-running…" : "Re-run"}
              </Button>
            </WithTooltip>
            {cloneEditHref ? (
              <WithTooltip tip="Open a new session form with replayable inputs copied from this session">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  data-pw="session-clone-edit"
                  onClick={() => router.push(cloneEditHref)}
                >
                  Clone &amp; Edit
                </Button>
              </WithTooltip>
            ) : null}
          </>
        ) : null}
        <WithTooltip tip="Move current logs to durable archive storage">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            aria-busy={pending && action === "archive"}
            data-pw="session-archive"
            onClick={() => void run("archive", "archive")}
          >
            {pending && action === "archive" ? "Archiving…" : "Archive logs"}
          </Button>
        </WithTooltip>
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="session-action-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
