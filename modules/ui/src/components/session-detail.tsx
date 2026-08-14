import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { DetailHeader, type Crumb } from "./detail-header.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { SessionRouteSummary } from "./session-route-summary.tsx";
import { SessionExecutionSummary } from "./session-execution-summary.tsx";
import { SessionIdCopyButton } from "./session-id-copy-button.tsx";
import { SessionDetailTiming } from "./session-detail-timing.tsx";
import { SessionSourceBadge } from "./session-source-badge.tsx";
import { SessionTimeoutDetail } from "./session-timeout-progress.tsx";
import type { SessionSummary } from "./session-detail-types.ts";

export type { SessionSummary } from "./session-detail-types.ts";

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

function SessionDetailValue({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="text-sm">{value ?? "—"}</dd>
    </div>
  );
}

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
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Worktree</dt>
              <dd className="font-mono text-sm" data-pw="session-detail-worktree">
                {s.worktreeId ? (
                  worktreeHrefBase ? (
                    <Link
                      href={`${worktreeHrefBase}/${encodeURIComponent(s.worktreeId)}`}
                      className="hover:underline"
                    >
                      {s.worktreeId}
                    </Link>
                  ) : (
                    s.worktreeId
                  )
                ) : s.type === "scheduled" ? (
                  "Main checkout"
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Source</dt>
              <dd className="text-sm" data-pw="session-detail-source">
                <SessionSourceBadge source={s.source} />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Priority</dt>
              <dd className="text-sm" data-pw="session-detail-priority">
                {s.priority ?? "—"}
              </dd>
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
            <SessionDetailTiming
              createdAt={s.createdAt}
              startedAt={s.startedAt}
              completedAt={s.completedAt}
              status={s.status}
            />
            <SessionDetailValue label="Exit code" value={s.exitCode} />
          </dl>
          <section aria-labelledby="session-detail-prompt-heading" data-pw="session-detail-prompt">
            <h3
              id="session-detail-prompt-heading"
              className="text-xs uppercase text-muted-foreground"
            >
              Prompt
            </h3>
            <pre
              className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-4 font-sans text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-pw="session-detail-prompt-content"
              tabIndex={0}
            >
              {s.prompt ?? "—"}
            </pre>
          </section>
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
