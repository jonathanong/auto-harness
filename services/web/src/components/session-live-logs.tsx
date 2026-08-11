"use client";

import { SessionLogs } from "@auto-harness/ui";
import { useEffect, useRef, useState } from "react";

import {
  lastLiveCursor,
  mergeLiveLogs,
  validLiveLog,
  viewerWebSocketUrl,
  type LiveLogEntry,
} from "./live-session-logs.ts";

type ViewerState = "live" | "reconnecting" | "paused" | "error";

export function SessionLiveLogs({
  sessionId,
  initialItems,
}: {
  sessionId: string;
  initialItems: LiveLogEntry[];
}) {
  const [items, setItems] = useState(() =>
    initialItems.reduce((entries, item) => mergeLiveLogs(entries, item), [] as LiveLogEntry[]),
  );
  const [state, setState] = useState<ViewerState>("reconnecting");
  const cursorRef = useRef<string | undefined>(lastLiveCursor(initialItems));

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let terminalError = false;
    let attempts = 0;

    const reconnect = (): void => {
      if (stopped) return;
      const delay = Math.min(1_000 * 2 ** attempts, 30_000);
      attempts += 1;
      setState("reconnecting");
      retryTimer = setTimeout(connect, delay);
    };
    const connect = (): void => {
      if (stopped) return;
      try {
        socket = new WebSocket(viewerWebSocketUrl());
      } catch {
        reconnect();
        return;
      }
      socket.addEventListener("open", () => {
        attempts = 0;
        socket?.send(
          JSON.stringify({
            type: "viewer:subscribe",
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
        const wire = message as { type?: unknown; record?: unknown; code?: unknown };
        const record = wire.record;
        if (wire.type === "viewer:subscribed") {
          setState("live");
        } else if (wire.type === "viewer:log" && validLiveLog(record)) {
          setItems((current) => {
            const next = mergeLiveLogs(current, record);
            cursorRef.current = lastLiveCursor(next);
            return next;
          });
        } else if (wire.type === "viewer:error") {
          setState(wire.code === "NOT_FOUND" ? "error" : "paused");
          terminalError = wire.code === "NOT_FOUND";
          if (terminalError) socket?.close(1000, "session unavailable");
        }
      });
      socket.addEventListener("error", () => undefined);
      socket.addEventListener("close", () => {
        socket = undefined;
        if (!stopped && !terminalError) reconnect();
      });
    };
    connect();
    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close(1000, "session viewer unmounted");
    };
  }, [sessionId]);

  return (
    <div className="space-y-2">
      <p
        className="text-sm text-muted-foreground"
        data-pw="session-logs-live-state"
        aria-live="polite"
      >
        {state === "live" && "Live"}
        {state === "reconnecting" && "Reconnecting logs…"}
        {state === "paused" && "Live logs paused."}
        {state === "error" && "Live logs unavailable."}
      </p>
      <SessionLogs items={items} />
    </div>
  );
}
