import { isTerminalSessionStatus } from "@auto-harness/shared";

import { Alert } from "./alert.tsx";
import {
  isActiveInfrastructureRetry,
  sessionErrorLabel,
  sessionInfrastructureRetryReason,
} from "./session-status-cell.tsx";

export type SessionExecutionSummaryProps = {
  status: string;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  resumeFallback?: boolean | null | undefined;
  resumedFromSessionId?: string | null | undefined;
  infrastructureRetryCount?: number | null | undefined;
  lastInfrastructureErrorCode?: string | null | undefined;
};

/** Terminal error and fresh-resume notices shown above session detail tabs. */
export function SessionExecutionSummary({
  status,
  errorCode,
  errorMessage,
  resumeFallback,
  resumedFromSessionId,
  infrastructureRetryCount,
  lastInfrastructureErrorCode,
}: SessionExecutionSummaryProps) {
  const terminal = isTerminalSessionStatus(status);
  const showError = Boolean(errorMessage || (terminal && errorCode));
  const retrying = isActiveInfrastructureRetry(
    status,
    infrastructureRetryCount,
    errorCode,
    errorMessage,
  );
  const retryReason =
    sessionInfrastructureRetryReason(lastInfrastructureErrorCode) ?? "an infrastructure failure";
  return (
    <>
      {retrying ? (
        <Alert variant="warning" data-pw="session-detail-infrastructure-retry" role="status">
          Automatic retry {infrastructureRetryCount} of 1 is in progress after {retryReason}. The
          original queue deadline and session concurrency lock are preserved.
        </Alert>
      ) : null}
      {showError ? (
        <Alert variant="danger" data-pw="session-detail-error" role={terminal ? "alert" : "status"}>
          {errorCode ? (
            <span className="font-semibold">
              {sessionErrorLabel(errorCode)}
              {errorMessage ? ": " : ""}
            </span>
          ) : null}
          {errorMessage || "Session ended with this error code."}
        </Alert>
      ) : null}
      {resumeFallback ? (
        <Alert variant="warning" data-pw="session-detail-resume-fallback">
          Native resume was unavailable; this session ran as a fresh attempt through the configured
          route.
          {resumedFromSessionId ? ` Resumed from ${resumedFromSessionId}.` : ""}
        </Alert>
      ) : null}
    </>
  );
}
