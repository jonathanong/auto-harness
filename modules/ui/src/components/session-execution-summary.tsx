import { isTerminalSessionStatus } from "@auto-harness/shared";

import { Alert } from "./alert.tsx";

export type SessionExecutionSummaryProps = {
  status: string;
  errorCode?: string | null | undefined;
  errorMessage?: string | null | undefined;
  resumeFallback?: boolean | null | undefined;
  resumedFromSessionId?: string | null | undefined;
};

/** Terminal error and fresh-resume notices shown above session detail tabs. */
export function SessionExecutionSummary({
  status,
  errorCode,
  errorMessage,
  resumeFallback,
  resumedFromSessionId,
}: SessionExecutionSummaryProps) {
  const terminal = isTerminalSessionStatus(status);
  const showError = Boolean(errorMessage || (terminal && errorCode));
  return (
    <>
      {showError ? (
        <Alert variant="danger" data-pw="session-detail-error" role={terminal ? "alert" : "status"}>
          {errorCode ? (
            <span className="font-semibold">
              {errorCode}
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
