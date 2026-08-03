"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "./button.tsx";
import { WithTooltip } from "./tooltip.tsx";

const ACTIVE_STATUSES = new Set(["queued", "running"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export type SessionActionsProps = {
  sessionId: string;
  status: string;
  /** Where a successful resume navigates (a new session id is appended). Default "/sessions". */
  detailHrefBase?: string;
};

/** Cancel/resume/archive — pure REST against the same-origin `/api/v1` proxy, no app wiring needed. */
export function SessionActions({
  sessionId,
  status,
  detailHrefBase = "/sessions",
}: SessionActionsProps) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [action, setAction] = useState<"cancel" | "resume" | "archive" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (which: "cancel" | "resume" | "archive", path: string) => {
    setError(null);
    setAction(which);
    start(async () => {
      const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/${path}`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(await res.text());
        return;
      }
      if (which === "resume") {
        const body = (await res.json()) as { id?: string };
        if (body.id) {
          router.push(`${detailHrefBase}/${encodeURIComponent(body.id)}`);
          return;
        }
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-2">
        {ACTIVE_STATUSES.has(status) ? (
          <WithTooltip tip="Cancel this session — running work finishes stopping, worktree is released">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              data-pw="session-cancel"
              onClick={() => run("cancel", "cancel")}
            >
              {pending && action === "cancel" ? "…" : "Cancel"}
            </Button>
          </WithTooltip>
        ) : null}
        {TERMINAL_STATUSES.has(status) ? (
          <WithTooltip tip="Create a new session pinned to the same host, resuming from here">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              data-pw="session-resume"
              onClick={() => run("resume", "resume")}
            >
              {pending && action === "resume" ? "…" : "Resume"}
            </Button>
          </WithTooltip>
        ) : null}
        <WithTooltip tip="Move current logs to durable archive storage">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={pending}
            data-pw="session-archive"
            onClick={() => run("archive", "archive")}
          >
            {pending && action === "archive" ? "…" : "Archive logs"}
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
