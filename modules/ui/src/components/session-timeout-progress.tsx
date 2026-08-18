"use client";

import { useEffect, useState } from "react";

type SessionTimeoutProgressProps = {
  status: string;
  ackReceivedAt?: string | null | undefined;
  timeout?: number | null | undefined;
};

type TimeoutProgress = {
  elapsedSeconds: number;
  remainingSeconds: number;
  timeoutSeconds: number;
  elapsedPercent: number;
};

/** Derive a bounded running-session deadline without inventing server state. */
export function timeoutProgress(
  { status, ackReceivedAt, timeout }: SessionTimeoutProgressProps,
  nowMs: number,
): TimeoutProgress | null {
  if (status !== "running" || !ackReceivedAt || timeout == null || timeout <= 0) return null;
  const acknowledgedMs = Date.parse(ackReceivedAt);
  if (!Number.isFinite(acknowledgedMs) || !Number.isFinite(timeout)) return null;
  const elapsedSeconds = Math.min(timeout, Math.max(0, (nowMs - acknowledgedMs) / 1_000));
  const remainingSeconds = Math.max(0, timeout - elapsedSeconds);
  return {
    elapsedSeconds,
    remainingSeconds,
    timeoutSeconds: timeout,
    elapsedPercent: (elapsedSeconds / timeout) * 100,
  };
}

export function formatRemainingTime(seconds: number): string {
  const rounded = Math.ceil(seconds);
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remainder = rounded % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainder}s`;
  if (minutes > 0) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
}

/** Live, client-only timeout progress for an actively running session. */
export function SessionTimeoutProgress(props: SessionTimeoutProgressProps) {
  const [nowMs, setNowMs] = useState<number | null>(null);
  const active =
    props.status === "running" &&
    Boolean(props.ackReceivedAt) &&
    props.timeout != null &&
    props.timeout > 0 &&
    Number.isFinite(props.timeout) &&
    Number.isFinite(Date.parse(props.ackReceivedAt as string));

  useEffect(() => {
    if (!active) return;
    const deadlineMs = Date.parse(props.ackReceivedAt as string) + props.timeout! * 1_000;
    const initialNow = Date.now();
    setNowMs(initialNow);
    if (initialNow >= deadlineMs) return;
    const interval = setInterval(() => {
      const nextNow = Date.now();
      setNowMs(nextNow);
      if (nextNow >= deadlineMs) clearInterval(interval);
    }, 1_000);
    return () => clearInterval(interval);
  }, [active, props.ackReceivedAt, props.timeout]);

  const progress = nowMs == null ? null : timeoutProgress(props, nowMs);
  if (!progress || progress.remainingSeconds <= 0) return null;
  const remaining = formatRemainingTime(progress.remainingSeconds);

  return (
    <div className="mt-2 space-y-1" data-pw="session-timeout-progress">
      <div
        role="progressbar"
        aria-label="Session timeout"
        aria-valuemin={0}
        aria-valuemax={progress.timeoutSeconds}
        aria-valuenow={progress.elapsedSeconds}
        aria-valuetext={`${remaining} remaining`}
        className="h-2 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300"
          style={{ width: `${progress.elapsedPercent}%` }}
        />
      </div>
      <p className="text-xs text-muted-foreground" data-pw="session-timeout-remaining">
        <span suppressHydrationWarning>{remaining} remaining</span>
      </p>
    </div>
  );
}

export function SessionTimeoutDetail(props: SessionTimeoutProgressProps) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">Timeout</dt>
      <dd className="text-sm" data-pw="session-detail-timeout">
        {props.timeout != null ? `${props.timeout}s` : "—"}
        <SessionTimeoutProgress {...props} />
      </dd>
    </div>
  );
}
