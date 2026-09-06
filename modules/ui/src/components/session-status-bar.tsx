"use client";

import type { ReactNode } from "react";

import { cn } from "../lib/utils.ts";
import { SessionDurationValue } from "./session-detail-timing.tsx";
import type { SessionSummary } from "./session-detail-types.ts";
import { SessionExitCode } from "./session-exit-code.tsx";
import { SessionQueueDeadline } from "./session-queue-deadline.tsx";
import { sessionProviderLabel } from "./session-route-summary.tsx";
import { SessionSourceBadge } from "./session-source-badge.tsx";
import { SessionStatusDetail } from "./session-status-cell.tsx";

function StatusItem({
  label,
  children,
  pw,
  valueClassName,
}: {
  label: string;
  children: ReactNode;
  pw?: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 border-border py-0.5 not-first:border-l not-first:pl-4">
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm", valueClassName)} data-pw={pw}>
        {children}
      </dd>
    </div>
  );
}

/** Compact key-field strip under the session title. Canonical `data-pw` ids live here. */
export function SessionStatusBar({ session: s }: { session: SessionSummary }) {
  return (
    <dl
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3"
      data-pw="session-status-bar"
    >
      <StatusItem label="Status">
        <SessionStatusDetail status={s.status} errorCode={s.errorCode} />
      </StatusItem>
      <StatusItem
        label="Provider"
        pw="session-status-bar-provider"
        valueClassName="font-mono text-sm"
      >
        {sessionProviderLabel(s)}
      </StatusItem>
      {s.startedAt ? (
        <StatusItem label="Duration">
          <SessionDurationValue
            status={s.status}
            startedAt={s.startedAt}
            completedAt={s.completedAt}
          />
        </StatusItem>
      ) : null}
      {s.exitCode != null ? (
        <StatusItem label="Exit">
          <SessionExitCode exitCode={s.exitCode} />
        </StatusItem>
      ) : null}
      <StatusItem label="Source" pw="session-detail-source">
        <SessionSourceBadge source={s.source} />
      </StatusItem>
      <SessionQueueDeadline compact status={s.status} queueExpiresAt={s.queueExpiresAt} />
    </dl>
  );
}
