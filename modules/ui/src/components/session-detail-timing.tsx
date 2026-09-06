"use client";

import { useEffect, useState } from "react";

import { formatDuration, sessionDurationMs } from "./session-time.tsx";

export function SessionDurationValue({
  status,
  startedAt,
  completedAt,
  initialNow = Date.now(),
  pw = "session-detail-duration",
}: {
  status: string;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  initialNow?: number | undefined;
  /** Pass `null` when a sibling already owns `session-detail-duration`. */
  pw?: string | null | undefined;
}) {
  const running = status === "running";
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);

  const duration = sessionDurationMs({ status, startedAt, completedAt }, now);
  return (
    <span className="tabular-nums" data-pw={pw ?? undefined} suppressHydrationWarning>
      {duration === null ? "—" : formatDuration(duration)}
    </span>
  );
}

export function SessionDetailTiming({
  createdAt,
  startedAt,
  completedAt,
  status,
  initialNow = Date.now(),
  durationPw = "session-detail-duration",
}: {
  createdAt?: string | null | undefined;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
  status: string;
  initialNow?: number | undefined;
  durationPw?: string | null | undefined;
}) {
  return (
    <>
      <TimeField label="Created" value={createdAt} pw="session-detail-created" />
      <TimeField label="Started" value={startedAt} pw="session-detail-started" />
      <TimeField label="Completed" value={completedAt} pw="session-detail-completed" />
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Duration</dt>
        <dd className="text-sm">
          <SessionDurationValue
            status={status}
            startedAt={startedAt}
            completedAt={completedAt}
            initialNow={initialNow}
            pw={durationPw}
          />
        </dd>
      </div>
    </>
  );
}

function TimeField({
  label,
  value,
  pw,
}: {
  label: string;
  value?: string | null | undefined;
  pw: string;
}) {
  const timestamp = parseDate(value);
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="text-sm" data-pw={pw}>
        {timestamp === null ? (
          "—"
        ) : (
          <time dateTime={value as string} title={new Date(timestamp).toISOString()}>
            {formatTimestamp(timestamp)}
          </time>
        )}
      </dd>
    </div>
  );
}

function parseDate(value?: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  });
}
