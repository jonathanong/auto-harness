"use client";

import { useEffect, useState } from "react";

type SessionQueueDeadlineProps = {
  status: string;
  queueExpiresAt?: string | null | undefined;
  initialNow?: number;
};

const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function parseCanonicalDeadline(value?: string | null): number {
  if (!value || !CANONICAL_UTC_TIMESTAMP.test(value)) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : Number.NaN;
}

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  if (minutes > 0) return `${minutes}m ${seconds}s remaining`;
  return `${seconds}s remaining`;
}

type SessionQueueDeadlineViewProps = SessionQueueDeadlineProps & {
  compact?: boolean | undefined;
  /** Pass `null` when a sibling already owns `session-detail-queue-deadline`. */
  pw?: string | null | undefined;
};

/** Queued-session deadline with a hydration-safe, bounded live countdown. */
export function SessionQueueDeadline({
  status,
  queueExpiresAt,
  initialNow,
  compact = false,
  pw = "session-detail-queue-deadline",
}: SessionQueueDeadlineViewProps) {
  const expiresAt = parseCanonicalDeadline(queueExpiresAt);
  const active = status === "queued" && Number.isFinite(expiresAt);
  const [now, setNow] = useState<number | null>(initialNow ?? null);

  useEffect(() => {
    if (!active) return;

    const current = initialNow ?? Date.now();
    setNow(current);
    if (current >= expiresAt) return;

    const interval = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= expiresAt) clearInterval(interval);
    }, 1_000);
    return () => clearInterval(interval);
  }, [active, expiresAt, initialNow]);

  if (!active || !queueExpiresAt) return null;
  const remaining = now === null ? null : expiresAt - now;
  const remainingLabel =
    remaining === null ? "" : remaining <= 0 ? "Deadline reached" : formatRemaining(remaining);
  const stamp = (
    <>
      <time
        dateTime={queueExpiresAt}
        title={new Date(expiresAt).toISOString()}
        aria-label={`Queue deadline ${new Date(expiresAt).toISOString()}`}
      >
        {new Date(expiresAt).toLocaleString("en-US", {
          dateStyle: "medium",
          timeStyle: "medium",
          timeZone: "UTC",
        })}
      </time>{" "}
      <span className="tabular-nums text-muted-foreground" suppressHydrationWarning>
        {remainingLabel}
      </span>
    </>
  );
  if (compact) {
    return (
      <div
        className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-border py-0.5 not-first:border-l not-first:pl-4"
        data-pw={pw ?? undefined}
      >
        <dt className="text-xs uppercase text-muted-foreground">Queue</dt>
        <dd className="text-sm">{stamp}</dd>
      </div>
    );
  }

  return (
    <div data-pw={pw ?? undefined}>
      <dt className="text-xs uppercase text-muted-foreground">Queue deadline</dt>
      <dd className="text-sm">{stamp}</dd>
    </div>
  );
}
