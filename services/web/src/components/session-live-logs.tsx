"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  lastLiveCursor,
  mergeInitialLiveLogs,
  mergeLiveLogs,
  validLiveLog,
  viewerWebSocketUrl,
  viewerTicket,
  type LiveLogEntry,
} from "../lib/live-session-logs.ts";
import { SessionTerminalViewer } from "./session-terminal-viewer.tsx";

type ConnectionState = "connecting" | "live" | "reconnecting" | "error";

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
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [sessionStatus, setSessionStatus] = useState(initialStatus);
  const [error, setError] = useState<string | null>(null);
  const cursorRef = useRef<string | undefined>(lastLiveCursor(initialLogs));

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let terminalError = false;
    let attempts = 0;

    const reconnect = (): void => {
      if (stopped || terminalError) return;
      const delay = Math.min(500 * 2 ** attempts, 30_000);
      attempts += 1;
      setConnectionState("reconnecting");
      retryTimer = setTimeout(connect, delay);
    };
    const connect = (): void => {
      if (stopped || terminalError) return;
      void viewerTicket()
        .then((ticket) => {
          if (stopped || terminalError) return;
          socket = new WebSocket(viewerWebSocketUrl(ticket));
          socket.addEventListener("open", () => {
            attempts = 0;
            socket?.send(
              JSON.stringify({
                type: "session:subscribe",
                sessionId,
                ...(cursorRef.current ? { after: cursorRef.current } : {}),
              }),
            );
          });
          socket.addEventListener("message", (event) => {
            let message: unknown;
            try {
              message = JSON.parse(String(event.data));
            } catch {
              return;
            }
            if (!message || typeof message !== "object" || Array.isArray(message)) return;
            const wire = message as { type?: unknown; code?: unknown; status?: unknown } & Record<
              string,
              unknown
            >;
            if (wire.type === "session:subscribed") {
              setConnectionState("live");
              setError(null);
              if (typeof wire.status === "string") setSessionStatus(wire.status);
              return;
            }
            if (wire.type === "session:log" && validLiveLog(wire)) {
              setItems((current) => {
                const next = mergeLiveLogs(current, wire);
                cursorRef.current = lastLiveCursor(next);
                return next;
              });
              return;
            }
            if (wire.type === "session:status" && typeof wire.status === "string") {
              setSessionStatus(wire.status);
              return;
            }
            if (wire.type === "session:error") {
              terminalError = wire.code === "NOT_FOUND" || wire.code === "SUBSCRIPTION_LIMIT";
              setConnectionState("error");
              setError(
                terminalError
                  ? "Live logs are unavailable for this session."
                  : "Live logs paused; reconnecting…",
              );
              socket?.close(terminalError ? 1000 : 1011, "viewer error");
            }
          });
          socket.addEventListener("close", (event) => {
            socket = undefined;
            if (!stopped && !terminalError) {
              setError(`Live connection closed (${event.code}); retrying…`);
            }
            reconnect();
          });
        })
        .catch(reconnect);
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "session:unsubscribe", sessionId }));
      }
      socket?.close(1000, "session log viewer unmounted");
    };
  }, [sessionId]);

  return (
    <div className="space-y-2" data-pw="session-logs-live-tail">
      <p
        className="text-sm text-muted-foreground"
        data-pw="session-logs-live-state"
        aria-live="polite"
      >
        {connectionState === "connecting" && "Connecting live logs…"}
        {connectionState === "live" && `Live — ${sessionStatus}`}
        {connectionState === "reconnecting" && "Reconnecting live logs…"}
        {connectionState === "error" && "Live logs unavailable"}
      </p>
      {error ? (
        <p className="text-sm text-destructive" data-pw="session-logs-live-error" role="alert">
          {error}
        </p>
      ) : null}
      <SessionTerminalViewer sessionId={sessionId} items={items} />
    </div>
  );
}
