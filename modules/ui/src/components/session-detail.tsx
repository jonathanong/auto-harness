import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { DetailHeader, type Crumb } from "./detail-header.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { SessionRouteSummary } from "./session-route-summary.tsx";
import { SessionExecutionSummary } from "./session-execution-summary.tsx";
import { SessionIdCopyButton } from "./session-id-copy-button.tsx";
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
            <SessionDetailValue label="Source" value={s.source} />
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
            <SessionDetailValue label="Created" value={s.createdAt} />
            <SessionDetailValue label="Started" value={s.startedAt} />
            <SessionDetailValue label="Completed" value={s.completedAt} />
            <SessionDetailValue label="Exit code" value={s.exitCode} />
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
