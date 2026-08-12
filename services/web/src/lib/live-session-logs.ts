export type LiveLogEntry = {
  timestampSeq: string;
  seq: number;
  stream: string;
  content: string;
  timestamp: string;
};

export const MAX_LIVE_LOG_ENTRIES = 1_000;

/** Merge REST history and replayed tail records without retaining an unbounded terminal. */
export function mergeLiveLogs(
  current: LiveLogEntry[],
  incoming: LiveLogEntry,
  maxEntries = MAX_LIVE_LOG_ENTRIES,
): LiveLogEntry[] {
  if (!validLiveLog(incoming)) return current;
  const last = current.at(-1);
  if (!last || incoming.timestampSeq > last.timestampSeq) {
    return [...current, incoming].slice(-maxEntries);
  }
  const byCursor = new Map(current.map((entry) => [entry.timestampSeq, entry]));
  byCursor.set(incoming.timestampSeq, incoming);
  return [...byCursor.values()]
    .toSorted((left, right) => left.timestampSeq.localeCompare(right.timestampSeq))
    .slice(-maxEntries);
}

export function mergeInitialLiveLogs(items: LiveLogEntry[]): LiveLogEntry[] {
  const byCursor = new Map(
    items.filter(validLiveLog).map((entry) => [entry.timestampSeq, entry] as const),
  );
  return [...byCursor.values()]
    .toSorted((left, right) => left.timestampSeq.localeCompare(right.timestampSeq))
    .slice(-MAX_LIVE_LOG_ENTRIES);
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
    (record.stream === "stdout" || record.stream === "stderr" || record.stream === "system") &&
    typeof record.content === "string" &&
    typeof record.timestamp === "string"
  );
}

export async function viewerTicket(timeoutMs = 10_000): Promise<string | undefined> {
  const response = await fetch("/api/v1/auth/viewer-ticket", {
    method: "POST",
    credentials: "same-origin",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error("viewer ticket unavailable");
  const body = (await response.json()) as { ticket?: unknown };
  return typeof body.ticket === "string" ? body.ticket : undefined;
}

export function viewerWebSocketUrl(ticket?: string): string {
  const configured = process.env.NEXT_PUBLIC_HARNESS_VIEWER_WS_URL;
  if (configured) return withTicket(configured, ticket);
  if (typeof window === "undefined") return "ws://127.0.0.1:7421/ws/viewer";
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return withTicket(`${scheme}//${window.location.host}/ws/viewer`, ticket);
}

function withTicket(url: string, ticket: string | undefined): string {
  if (!ticket) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}ticket=${encodeURIComponent(ticket)}`;
}
