"use client";

import { useEffect, useMemo, useState } from "react";
import { SESSION_QUEUED_WAIT_COPY, SessionTerminalViewer } from "@auto-harness/ui";

import {
  liveLogsStateLabel,
  mergeInitialLiveLogs,
  type LiveLogEntry,
  type LiveLogsConnectionState,
} from "../lib/live-session-logs.ts";

export function SessionLiveLogs({
  sessionId,
  initialItems,
  initialStatus,
}: {
  sessionId: string;
  initialItems: LiveLogEntry[];
  initialStatus: string;
}) {
  const initialLogs = useMemo(() => mergeInitialLiveLogs(initialItems), [initialItems]);
  const [items, setItems] = useState(initialLogs);
  const [connectionState, setConnectionState] = useState<LiveLogsConnectionState>("connecting");
  const [sessionStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = (): void => {
      if (stopped) return;
      void fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/logs?limit=1000`, {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("log poll failed");
          const body = (await response.json()) as { items?: LiveLogEntry[] };
          const incoming = Array.isArray(body.items) ? body.items : [];
          setItems(mergeInitialLiveLogs(incoming));
          setConnectionState("live");
          setError(null);
        })
        .catch(() => {
          if (!stopped) {
            setConnectionState("error");
            setError("Session logs unavailable; retrying…");
          }
        })
        .finally(() => {
          if (!stopped) retryTimer = setTimeout(poll, 60_000);
        });
    };
    poll();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [sessionId]);

  return (
    <div className="space-y-2" data-pw="session-logs-live-tail">
      <p
        className="text-sm text-muted-foreground"
        data-pw="session-logs-live-state"
        aria-live="polite"
      >
        {liveLogsStateLabel(connectionState, sessionStatus)}
      </p>
      <p className="text-sm text-muted-foreground" data-pw="session-logs-s3-note">
        Near-real-time via S3. For a live PTY stream, open the host pane on that machine.
      </p>
      {sessionStatus === "queued" ? (
        <p className="text-sm text-muted-foreground">{SESSION_QUEUED_WAIT_COPY}</p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" data-pw="session-logs-live-error" role="alert">
          {error}
        </p>
      ) : null}
      <SessionTerminalViewer sessionId={sessionId} items={items} />
    </div>
  );
}
