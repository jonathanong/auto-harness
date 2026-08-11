import { cn } from "../lib/utils.ts";

export type LogEntry = {
  timestampSeq?: string;
  seq: number;
  stream: string;
  content: string;
  timestamp: string;
};

export type SessionLogsProps = {
  items: LogEntry[];
  emptyMessage?: string;
};

/** Monospace log viewer, ordered by the durable log cursor. */
export function SessionLogs({ items, emptyMessage = "No logs yet." }: SessionLogsProps) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-pw="session-logs-empty">
        {emptyMessage}
      </p>
    );
  }

  const sorted = [...items].toSorted((a, b) =>
    (a.timestampSeq ?? `${a.timestamp}#${String(a.seq).padStart(10, "0")}`).localeCompare(
      b.timestampSeq ?? `${b.timestamp}#${String(b.seq).padStart(10, "0")}`,
    ),
  );

  return (
    <div
      className="max-h-[32rem] space-y-0.5 overflow-y-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs"
      data-pw="session-logs"
    >
      {sorted.map((entry) => (
        <div
          key={entry.timestampSeq ?? `${entry.timestamp}:${entry.seq}:${entry.stream}`}
          className="flex gap-2 whitespace-pre-wrap break-words"
        >
          <span className="shrink-0 text-muted-foreground">{entry.timestamp}</span>
          <span
            className={cn(
              "shrink-0 font-semibold",
              entry.stream === "stderr" ? "text-red-700" : "text-muted-foreground",
            )}
          >
            {entry.stream}
          </span>
          <span>{entry.content}</span>
        </div>
      ))}
    </div>
  );
}
