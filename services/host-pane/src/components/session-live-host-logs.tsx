"use client";

import { useEffect, useMemo, useState } from "react";
import { SessionTerminalViewer } from "@auto-harness/ui";

type HostLogEntry = {
  timestampSeq: string;
  seq: number;
  stream: string;
  content: string;
  timestamp: string;
};

function merge(current: HostLogEntry[], incoming: HostLogEntry): HostLogEntry[] {
  const byCursor = new Map(current.map((entry) => [entry.timestampSeq, entry]));
  byCursor.set(incoming.timestampSeq, incoming);
  return [...byCursor.values()].toSorted((left, right) =>
    left.timestampSeq.localeCompare(right.timestampSeq),
  );
}

export function SessionLiveHostLogs({
  sessionId,
  initialItems,
}: {
  sessionId: string;
  initialItems: HostLogEntry[];
}) {
  const seed = useMemo(
    () =>
      [...initialItems].toSorted((left, right) =>
        left.timestampSeq.localeCompare(right.timestampSeq),
      ),
    [initialItems],
  );
  const [items, setItems] = useState(seed);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const source = new EventSource(`/live-logs/${encodeURIComponent(sessionId)}`);
    const onOpen = () => setLive(true);
    const onError = () => setLive(false);
    const onMessage = (event: MessageEvent<string>) => {
      try {
        const chunk = JSON.parse(event.data) as {
          timestamp?: string;
          stream?: string;
          content?: string;
          seq?: number;
        };
        if (typeof chunk.seq !== "number" || typeof chunk.content !== "string") return;
        const timestamp =
          typeof chunk.timestamp === "string" ? chunk.timestamp : new Date().toISOString();
        const padded = String(chunk.seq).padStart(16, "0");
        setItems((current) =>
          merge(current, {
            timestampSeq: `${timestamp}#${padded}`,
            seq: chunk.seq,
            stream:
              chunk.stream === "stderr" || chunk.stream === "system" ? chunk.stream : "stdout",
            content: chunk.content,
            timestamp,
          }),
        );
      } catch {
        // Ignore malformed frames.
      }
    };
    source.addEventListener("open", onOpen);
    source.addEventListener("error", onError);
    source.addEventListener("message", onMessage);
    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("error", onError);
      source.removeEventListener("message", onMessage);
      source.close();
    };
  }, [sessionId]);

  return (
    <div className="space-y-2" data-pw="session-logs-host-live">
      <p className="text-sm text-muted-foreground" data-pw="session-logs-host-live-state">
        {live ? "Live PTY stream from this host." : "Connecting to the local daemon stream…"}
      </p>
      <SessionTerminalViewer sessionId={sessionId} items={items} />
    </div>
  );
}
