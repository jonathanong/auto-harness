import { SessionStatusBadge } from "./session-status-badge.tsx";

/** Waiting is expected when no host has capacity yet; a one-minute sweep retries. */
export const SESSION_QUEUED_WAIT_COPY =
  "Assignment is attempted immediately; a one-minute repair sweep retries missed work.";

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
  errorCode?: string | null | undefined;
  sessionId: string;
}) {
  const reason = status === "failed" ? sessionStatusReason(errorCode) : null;
  return (
    <div className="space-y-1" data-pw={`session-status-${sessionId}`}>
      <SessionStatusBadge status={status} />
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
  errorCode?: string | null | undefined;
}) {
  const reason = status === "failed" ? sessionStatusReason(errorCode) : null;
  return (
    <div className="space-y-1" data-pw="session-detail-status">
      <SessionStatusBadge status={status} />
      {reason ? (
        <div className="text-xs text-muted-foreground" data-pw="session-detail-status-reason">
          {reason}
        </div>
      ) : null}
      {status === "queued" ? (
        <div className="text-xs text-muted-foreground">{SESSION_QUEUED_WAIT_COPY}</div>
      ) : null}
    </div>
  );
}
