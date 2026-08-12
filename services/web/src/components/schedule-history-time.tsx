export function ScheduleHistoryTime({
  createdAt,
  completedAt,
  sessionId,
}: {
  createdAt?: string;
  completedAt?: string | null;
  sessionId: string;
}) {
  const created = parseDate(createdAt);
  const completed = parseDate(completedAt);
  const duration = created !== null && completed !== null ? Math.max(0, completed - created) : null;

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

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}
