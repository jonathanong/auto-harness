import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { DetailHeader, type Crumb } from "./detail-header.tsx";
import { StatusBadge } from "./status-badge.tsx";

export type SessionSummary = {
  id: string;
  status: string;
  repositoryId?: string | null;
  agentId?: string | null;
  worktreeId?: string | null;
  targetLabel?: string | null;
  resolvedArgv?: string[] | null;
  prompt?: string | null;
  source?: string | null;
  ref?: string | null;
  timeout?: number | null;
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
  /** When set, the host field links to `${hostHrefBase}/${encodeURIComponent(agentId)}` (control plane only — the host pane has no per-host route). */
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
        title={<span className="font-mono">{s.id}</span>}
        titlePw="session-detail-id"
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
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Target</dt>
              <dd className="font-mono text-sm">{s.targetLabel ?? "—"}</dd>
            </div>
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
            {s.agentId ? (
              <div>
                <dt className="text-xs uppercase text-muted-foreground">Host</dt>
                <dd className="font-mono text-sm">
                  {hostHrefBase ? (
                    <Link
                      href={`${hostHrefBase}/${encodeURIComponent(s.agentId)}`}
                      className="hover:underline"
                    >
                      {s.agentId}
                    </Link>
                  ) : (
                    s.agentId
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
              <dt className="text-xs uppercase text-muted-foreground">Timeout</dt>
              <dd className="text-sm">{s.timeout != null ? `${s.timeout}s` : "—"}</dd>
            </div>
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
          {s.resolvedArgv && s.resolvedArgv.length > 0 ? (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Resolved argv</dt>
              <dd
                className="whitespace-pre-wrap break-words font-mono text-sm"
                data-pw="session-detail-resolved-argv"
              >
                {s.resolvedArgv.join(" ")}
              </dd>
            </div>
          ) : null}
          {s.errorMessage ? (
            <p
              className="rounded-md border border-destructive/40 bg-red-50 p-3 text-sm text-red-900"
              data-pw="session-detail-error"
            >
              {s.errorCode ? <span className="font-semibold">{s.errorCode}: </span> : null}
              {s.errorMessage}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {children}
    </div>
  );
}
