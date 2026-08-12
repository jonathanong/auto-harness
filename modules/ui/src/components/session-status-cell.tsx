import { StatusBadge } from "./status-badge.tsx";

export function sessionStatusReason(errorCode?: string | null): string | null {
  if (errorCode === "usage_limit") return "Usage limit";
  if (errorCode === "queue_expired") return "Queue expired";
  return null;
}

/** Status badge plus the documented human-readable terminal reason. */
export function SessionStatusCell({
  status,
  errorCode,
  sessionId,
}: {
  status: string;
  errorCode?: string | null;
  sessionId: string;
}) {
  const reason = status === "failed" ? sessionStatusReason(errorCode) : null;
  return (
    <div className="space-y-1" data-pw={`session-status-${sessionId}`}>
      <StatusBadge status={status} />
      {reason ? (
        <div
          className="text-xs text-muted-foreground"
          data-pw={`session-status-reason-${sessionId}`}
        >
          {reason}
        </div>
      ) : null}
    </div>
  );
}

export function SessionStatusDetail({
  status,
  errorCode,
}: {
  status: string;
  errorCode?: string | null;
}) {
  const reason = sessionStatusReason(errorCode);
  return (
    <div className="space-y-1" data-pw="session-detail-status">
      <StatusBadge status={status} />
      {reason ? (
        <div className="text-xs text-muted-foreground" data-pw="session-detail-status-reason">
          {reason}
        </div>
      ) : null}
    </div>
  );
}
