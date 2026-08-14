import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { DetailHeader, type Crumb } from "./detail-header.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { SessionRouteSummary } from "./session-route-summary.tsx";
import { SessionExecutionSummary } from "./session-execution-summary.tsx";
import { SessionIdCopyButton } from "./session-id-copy-button.tsx";
import { SessionTimeoutDetail } from "./session-timeout-progress.tsx";

export type SessionSummary = {
  id: string;
  status: string;
  repositoryId?: string | null;
  hostId?: string | null;
  worktreeId?: string | null;
  targetLabel?: string | null;
  targetLabels?: string[] | null;
  target?: { providerId?: string; commandId?: string } | null;
  fallbacks?: Array<{ providerId?: string; commandId?: string }> | null;
  queueTtlSeconds?: number | null;
  queueExpiresAt?: string | null;
  resolvedProviderAccountId?: string | null;
  resolvedCommandId?: string | null;
  resolvedHostId?: string | null;
  resolvedRoute?: {
    targetIndex?: number;
    providerAccountId?: string | null;
    commandId?: string | null;
    hostId?: string | null;
    worktreeId?: string | null;
  } | null;
  resumedFromSessionId?: string | null;
  resumeFallback?: boolean | null;
  resolvedArgv?: string[] | null;
  prompt?: string | null;
  source?: string | null;
  concurrencyId?: string | null;
  ref?: string | null;
  timeout?: number | null;
  ackReceivedAt?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
};

export type SessionDetailProps = {
  session: SessionSummary;
  breadcrumbs: Crumb[];
  /** Rendered in a row under the title (e.g. cancel/resume/archive buttons). */
  actions?: ReactNode;
  /** Rendered below the details card (e.g. a logs section). */
  children?: ReactNode;
  /** When set, the repository field links to `${repoHrefBase}/${encodeURIComponent(repositoryId)}`. */
  repoHrefBase?: string;
  /** When set, the host field links to `${hostHrefBase}/${encodeURIComponent(hostId)}` (control plane only — the host pane has no per-host route). */
  hostHrefBase?: string;
  /** When set, the worktree field links to `${worktreeHrefBase}/${encodeURIComponent(worktreeId)}`. */
  worktreeHrefBase?: string;
};

/** Shared session detail view — reused by the host pane and control page. */
export function SessionDetail({
  session: s,
  breadcrumbs,
  actions,
  children,
  repoHrefBase,
  hostHrefBase,
  worktreeHrefBase,
}: SessionDetailProps) {
  return (
    <div className="space-y-6" data-pw="session-detail">
      <DetailHeader
        breadcrumbs={breadcrumbs}
        title={
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="font-mono" data-pw="session-detail-id">
              {s.id}
            </span>
            <SessionIdCopyButton sessionId={s.id} />
          </span>
        }
        actions={actions}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Status</dt>
              <dd data-pw="session-detail-status">
                <StatusBadge status={s.status} />
              </dd>
            </div>
            <SessionRouteSummary session={s} />
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Repository</dt>
              <dd className="font-mono text-sm">
                {s.repositoryId ? (
                  repoHrefBase ? (
                    <Link
                      href={`${repoHrefBase}/${encodeURIComponent(s.repositoryId)}`}
                      className="hover:underline"
                    >
                      {s.repositoryId}
                    </Link>
                  ) : (
                    s.repositoryId
                  )
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Ref</dt>
              <dd className="font-mono text-sm">{s.ref ?? "—"}</dd>
            </div>
            {s.hostId ? (
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Host</dt>
                <dd className="font-mono text-sm">
                  {hostHrefBase ? (
                    <Link
                      href={`${hostHrefBase}/${encodeURIComponent(s.hostId)}`}
                      className="hover:underline"
                    >
                      {s.hostId}
                    </Link>
                  ) : (
                    s.hostId
                  )}
                </dd>
              </div>
            ) : null}
            {s.worktreeId ? (
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Worktree</dt>
                <dd className="font-mono text-sm">
                  {worktreeHrefBase ? (
                    <Link
                      href={`${worktreeHrefBase}/${encodeURIComponent(s.worktreeId)}`}
                      className="hover:underline"
                    >
                      {s.worktreeId}
                    </Link>
                  ) : (
                    s.worktreeId
                  )}
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Source</dt>
              <dd className="text-sm">{s.source ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Concurrency ID</dt>
              <dd className="font-mono text-sm" data-pw="session-detail-concurrency-id">
                {s.concurrencyId ?? "—"}
              </dd>
            </div>
            <SessionTimeoutDetail
              status={s.status}
              ackReceivedAt={s.ackReceivedAt}
              timeout={s.timeout}
            />
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Created</dt>
              <dd className="text-sm">{s.createdAt ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Started</dt>
              <dd className="text-sm">{s.startedAt ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Completed</dt>
              <dd className="text-sm">{s.completedAt ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Exit code</dt>
              <dd className="text-sm">{s.exitCode ?? "—"}</dd>
            </div>
          </dl>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Prompt</dt>
            <dd className="whitespace-pre-wrap break-words text-sm">{s.prompt ?? "—"}</dd>
          </div>
          <SessionExecutionSummary
            resolvedArgv={s.resolvedArgv}
            errorCode={s.errorCode}
            errorMessage={s.errorMessage}
            resumeFallback={s.resumeFallback}
            resumedFromSessionId={s.resumedFromSessionId}
          />
        </CardContent>
      </Card>

      {children}
    </div>
  );
}
