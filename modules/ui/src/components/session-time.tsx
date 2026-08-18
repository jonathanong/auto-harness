"use client";

import { useEffect, useState } from "react";

const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

function timestampMs(value?: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatRelativeTime(value: string | null | undefined, nowMs: number): string | null {
  const parsed = timestampMs(value);
  if (parsed == null) return null;
  const deltaMs = parsed - nowMs;
  const absoluteMs = Math.abs(deltaMs);
  const [divisor, unit] =
    absoluteMs < 60_000
      ? ([1_000, "second"] as const)
      : absoluteMs < 3_600_000
        ? ([60_000, "minute"] as const)
        : absoluteMs < 86_400_000
          ? ([3_600_000, "hour"] as const)
          : ([86_400_000, "day"] as const);
  return RELATIVE_TIME.format(Math.round(deltaMs / divisor), unit);
}

export function sessionDurationMs(
  session: {
    status: string;
    startedAt?: string | null | undefined;
    completedAt?: string | null | undefined;
  },
  nowMs: number,
): number | null {
  const started = timestampMs(session.startedAt);
  if (started == null) return null;
  const completed = timestampMs(session.completedAt);
  const ended =
    session.status === "running" ? nowMs : TERMINAL_STATUSES.has(session.status) ? completed : null;
  return ended == null ? null : Math.max(0, ended - started);
}

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function useSessionClock(hasRunningSession: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(
      () => {
        setNowMs(Date.now());
      },
      hasRunningSession ? 1_000 : 60_000,
    );
    return () => clearInterval(interval);
  }, [hasRunningSession]);
  return nowMs;
}

function RelativeTimeDisplay({
  value,
  nowMs,
  label,
  pw,
}: {
  value?: string | null | undefined;
  nowMs: number;
  label?: string | undefined;
  pw?: string | undefined;
}) {
  const parsed = timestampMs(value);
  const relative = formatRelativeTime(value, nowMs);
  if (parsed == null || relative == null) return <span data-pw={pw}>—</span>;
  const full = new Date(parsed).toISOString();
  return (
    <time dateTime={full} title={full} data-pw={pw}>
      {label ? (
        <span className="sr-only">
          {label} {full}.{" "}
        </span>
      ) : null}
      <span suppressHydrationWarning>{relative}</span>
    </time>
  );
}

export function SessionCreatedTime({ value, nowMs }: { value?: string | null; nowMs: number }) {
  return <RelativeTimeDisplay value={value} nowMs={nowMs} label="Created" />;
}

/**
 * Self-contained relative time for callers with no shared clock to pass in (a handful of rows,
 * unlike the sessions table's single ticking clock shared across many). Ticks on its own
 * 60-second interval — no caller needs per-second precision for a connection or daemon-start time.
 */
export function RelativeTime({
  value,
  label,
  pw,
}: {
  value?: string | null;
  label?: string;
  pw?: string;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);
  return <RelativeTimeDisplay value={value} nowMs={nowMs} label={label} pw={pw} />;
}

export function SessionDuration({
  session,
  nowMs,
}: {
  session: { status: string; startedAt?: string | null; completedAt?: string | null };
  nowMs: number;
}) {
  const duration = sessionDurationMs(session, nowMs);
  if (duration == null) return <span>—</span>;
  const formatted = formatDuration(duration);
  const kind = session.status === "running" ? "Elapsed" : "Total";
  return (
    <time dateTime={`PT${Math.floor(duration / 1_000)}S`} title={`${kind} duration: ${formatted}`}>
      <span className="sr-only">{kind} duration: </span>
      <span suppressHydrationWarning>{formatted}</span>
    </time>
  );
}
