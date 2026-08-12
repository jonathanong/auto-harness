import { isTerminalSessionStatus } from "@auto-harness/shared";

export type SessionExecutionSummaryProps = {
  status: string;
  resolvedArgv?: string[] | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  resumeFallback?: boolean | null;
  resumedFromSessionId?: string | null;
};

/** Render execution output metadata and terminal/fresh-resume notices. */
export function SessionExecutionSummary({
  status,
  resolvedArgv,
  errorCode,
  errorMessage,
  resumeFallback,
  resumedFromSessionId,
}: SessionExecutionSummaryProps) {
  const terminal = isTerminalSessionStatus(status);
  const showError = Boolean(errorMessage || (terminal && errorCode));
  return (
    <>
      {resolvedArgv && resolvedArgv.length > 0 ? (
        <div>
          <dt className="text-xs uppercase text-muted-foreground">Resolved argv</dt>
          <dd
            className="whitespace-pre-wrap break-words font-mono text-sm"
            data-pw="session-detail-resolved-argv"
          >
            {resolvedArgv.join(" ")}
          </dd>
        </div>
      ) : null}
      {showError ? (
        <p
          className="rounded-md border border-destructive/40 bg-red-50 p-3 text-sm text-red-900"
          data-pw="session-detail-error"
          role={terminal ? "alert" : "status"}
        >
          {errorCode ? (
            <span className="font-semibold">
              {errorCode}
              {errorMessage ? ": " : ""}
            </span>
          ) : null}
          {errorMessage || "Session ended with this error code."}
        </p>
      ) : null}
      {resumeFallback ? (
        <p
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
          data-pw="session-detail-resume-fallback"
        >
          Native resume was unavailable; this session ran as a fresh attempt through the configured
          route.
          {resumedFromSessionId ? ` Resumed from ${resumedFromSessionId}.` : ""}
        </p>
      ) : null}
    </>
  );
}
