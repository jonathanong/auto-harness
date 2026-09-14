"use client";

import { useEffect, useMemo, useState } from "react";
import { SESSION_QUEUED_WAIT_COPY, SessionTerminalViewer } from "@auto-harness/ui";

import {
  liveLogsStateLabel,
  mergeInitialLiveLogs,
  viewerTicket,
  viewerWebSocketUrl,
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
  const [sessionStatus, setSessionStatus] = useState(initialStatus);
  useEffect(() => {
    setSessionStatus(initialStatus);
  }, [initialStatus]);
  const [error, setError] = useState<string | null>(null);
  const [pollMs, setPollMs] = useState(60_000);

  useEffect(() => {
    void fetch("/api/v1/session-log-settings", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as { controlPlanePollMs?: number };
        if (typeof body.controlPlanePollMs === "number" && body.controlPlanePollMs >= 5_000) {
          setPollMs(body.controlPlanePollMs);
        }
      })
      .catch(() => undefined);
  }, []);

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
          if (stopped) return;
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
          if (!stopped) retryTimer = setTimeout(poll, pollMs);
        });
    };
    poll();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [sessionId, pollMs]);

  useEffect(() => {
    let stopped = false;
    let socket: WebSocket | undefined;
    void viewerTicket()
      .then((ticket) => {
        if (stopped) return;
        socket = new WebSocket(viewerWebSocketUrl(ticket));
        socket.addEventListener("open", () => {
          socket?.send(JSON.stringify({ type: "session:subscribe", sessionId }));
        });
        socket.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(String(event.data)) as { type?: string };
            if (message.type === "session:log-part") {
              void fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/logs?limit=1000`, {
                credentials: "same-origin",
                cache: "no-store",
              })
                .then(async (response) => {
                  if (stopped || !response.ok) return;
                  const body = (await response.json()) as { items?: LiveLogEntry[] };
                  setItems(mergeInitialLiveLogs(Array.isArray(body.items) ? body.items : []));
                })
                .catch(() => undefined);
            }
          } catch {
            // Ignore malformed viewer frames.
          }
        });
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "session:unsubscribe", sessionId }));
      }
      socket?.close();
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
