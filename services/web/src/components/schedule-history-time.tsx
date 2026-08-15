import { formatDuration } from "@auto-harness/ui";

export function ScheduleHistoryTime({
  createdAt,
  startedAt,
  completedAt,
  sessionId,
}: {
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  sessionId: string;
}) {
  const created = parseDate(createdAt);
  const started = parseDate(startedAt);
  const completed = parseDate(completedAt);
  const duration = started !== null && completed !== null ? Math.max(0, completed - started) : null;

  return (
    <div className="text-xs" data-pw={`schedule-history-time-${sessionId}`}>
      {created === null ? (
        "—"
      ) : (
        <time dateTime={createdAt} title={new Date(created).toISOString()}>
          {new Date(created).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "UTC",
          })}
        </time>
      )}
      {duration !== null ? (
        <span className="block text-muted-foreground">{formatDuration(duration)}</span>
      ) : null}
    </div>
  );
}

function parseDate(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
