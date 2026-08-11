export type LiveLogEntry = {
  timestampSeq: string;
  seq: number;
  stream: string;
  content: string;
  timestamp: string;
};

export const MAX_LIVE_LOG_ENTRIES = 1_000;

/** Merge replay and tail records deterministically while bounding browser memory. */
export function mergeLiveLogs(
  current: LiveLogEntry[],
  incoming: LiveLogEntry,
  maxEntries = MAX_LIVE_LOG_ENTRIES,
): LiveLogEntry[] {
  if (!validLiveLog(incoming)) return current;
  const byCursor = new Map(current.map((entry) => [entry.timestampSeq, entry]));
  byCursor.set(incoming.timestampSeq, incoming);
  return [...byCursor.values()]
    .toSorted((a, b) => a.timestampSeq.localeCompare(b.timestampSeq))
    .slice(-maxEntries);
}

export function lastLiveCursor(entries: LiveLogEntry[]): string | undefined {
  return entries.at(-1)?.timestampSeq;
}

export function validLiveLog(value: unknown): value is LiveLogEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.timestampSeq === "string" &&
    record.timestampSeq.length > 0 &&
    typeof record.seq === "number" &&
    Number.isSafeInteger(record.seq) &&
    record.seq >= 0 &&
    typeof record.stream === "string" &&
    typeof record.content === "string" &&
    typeof record.timestamp === "string"
  );
}

export function viewerWebSocketUrl(): string {
  const configured = process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
  if (configured) return configured;
  if (typeof window === "undefined") return "ws://127.0.0.1:7420/ws/viewer";
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws/viewer`;
}
