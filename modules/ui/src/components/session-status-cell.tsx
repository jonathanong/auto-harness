import { SessionStatusBadge } from "./session-status-badge.tsx";

/** Waiting is expected when no host has capacity yet; a one-minute sweep retries. */
export const SESSION_QUEUED_WAIT_COPY =
  "Assignment is attempted immediately; a one-minute repair sweep retries missed work.";

export function sessionStatusReason(errorCode?: string | null): string | null {
  if (errorCode === "usage_limit") return "Usage limit";
  if (errorCode === "queue_expired") return "Queue expired";
  if (errorCode === "checkout_fetch_failed") return "Checkout fetch failed";
  if (errorCode === "host_lost") return "Host lost";
  return null;
}

/** A retry's host-loss checkpoint is known to precede command launch. */
export function sessionInfrastructureRetryReason(errorCode?: string | null): string | null {
  if (errorCode === "host_lost") return "Host lost before launch";
  return sessionStatusReason(errorCode);
}

/** Friendly labels for the bounded infrastructure failures exposed by the public session API. */
export function sessionErrorLabel(errorCode?: string | null): string | null {
  if (errorCode === "checkout_fetch_failed" || errorCode === "host_lost") {
    return sessionStatusReason(errorCode);
  }
  return errorCode ?? null;
}

function infrastructureRetryCopy(
  infrastructureRetryCount?: number | null,
  lastInfrastructureErrorCode?: string | null,
): string | null {
  if (!infrastructureRetryCount || infrastructureRetryCount < 1) return null;
  const reason =
    sessionInfrastructureRetryReason(lastInfrastructureErrorCode) ?? "an infrastructure failure";
  return `Automatic retry ${infrastructureRetryCount} of 1 in progress after ${reason}.`;
}

/** Status badge plus the documented human-readable terminal reason. */
export function SessionStatusCell({
  status,
  errorCode,
  errorMessage,
  sessionId,
  infrastructureRetryCount,
  lastInfrastructureErrorCode,
}: {
  status: string;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  sessionId: string;
  infrastructureRetryCount?: number | null | undefined;
  lastInfrastructureErrorCode?: string | null | undefined;
}) {
  const reason =
    status === "failed" ? sessionStatusReason(errorCode) || errorMessage || errorCode : null;
  const retry = infrastructureRetryCopy(infrastructureRetryCount, lastInfrastructureErrorCode);
  return (
    <div className="space-y-1" data-pw={`session-status-${sessionId}`}>
      <SessionStatusBadge status={status} />
      {reason ? (
        <div
          className="max-w-64 truncate text-xs text-muted-foreground"
          data-pw={`session-status-reason-${sessionId}`}
          title={reason}
        >
          {reason}
        </div>
      ) : null}
      {status === "queued" && retry ? (
        <div
          className="max-w-64 text-xs text-warning"
          data-pw={`session-status-retry-${sessionId}`}
        >
          {retry}
        </div>
      ) : null}
    </div>
  );
}

export function SessionStatusDetail({
  status,
  errorCode,
  infrastructureRetryCount,
  lastInfrastructureErrorCode,
}: {
  status: string;
  errorCode?: string | null | undefined;
  infrastructureRetryCount?: number | null | undefined;
  lastInfrastructureErrorCode?: string | null | undefined;
}) {
  const reason = status === "failed" ? sessionStatusReason(errorCode) : null;
  const retry = infrastructureRetryCopy(infrastructureRetryCount, lastInfrastructureErrorCode);
  return (
    <div className="space-y-1" data-pw="session-detail-status">
      <SessionStatusBadge status={status} />
      {reason ? (
        <div className="text-xs text-muted-foreground" data-pw="session-detail-status-reason">
          {reason}
        </div>
      ) : null}
      {status === "queued" && retry ? (
        <div className="text-xs text-warning" data-pw="session-detail-status-retry">
          {retry}
        </div>
      ) : null}
      {status === "queued" ? (
        <div className="text-xs text-muted-foreground">{SESSION_QUEUED_WAIT_COPY}</div>
      ) : null}
    </div>
  );
}
