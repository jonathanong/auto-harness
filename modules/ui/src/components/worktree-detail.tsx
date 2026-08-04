import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { StatusBadge } from "./status-badge.tsx";
import type { WorktreeRow } from "./worktrees-hierarchy.tsx";

export type WorktreeDetailProps = {
  worktree: WorktreeRow;
  backHref: string;
  /** Text after "← Back to " — default "worktrees". */
  backLabel?: string;
  /** Rendered top-right (e.g. a remove button). */
  actions?: ReactNode;
  /** Tab content (Sessions/Settings) rendered below the header. */
  children?: ReactNode;
};

/** Shared worktree detail header — reused by the host pane and control page. */
export function WorktreeDetail({
  worktree,
  backHref,
  backLabel = "worktrees",
  actions,
  children,
}: WorktreeDetailProps) {
  return (
    <div className="space-y-6" data-pw="worktree-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href={backHref}
            className="text-sm text-muted-foreground hover:underline"
            data-pw="worktree-detail-back"
          >
            ← Back to {backLabel}
          </Link>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="worktree-detail-id">
            {worktree.name}
          </h2>
        </div>
        {actions}
      </div>

      {children}
    </div>
  );
}

export type WorktreeDetailsCardProps = {
  worktree: WorktreeRow;
  /** Catalog repository name; falls back to worktree.repositoryId when unknown. */
  repositoryName?: string;
  /** When set, the repository field links to `${repoHrefBase}/${encodeURIComponent(repositoryId)}`. */
  repoHrefBase?: string;
  /** Host path of the repository root, if known. */
  repoPath?: string;
};

/** Worktree fields — the Settings tab's content. */
export function WorktreeDetailsCard({
  worktree,
  repositoryName,
  repoHrefBase,
  repoPath,
}: WorktreeDetailsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Id</dt>
            <dd className="font-mono text-xs text-muted-foreground">{worktree.id}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Repository</dt>
            <dd className="text-sm">
              {repoHrefBase ? (
                <Link
                  href={`${repoHrefBase}/${encodeURIComponent(worktree.repositoryId)}`}
                  className="hover:underline"
                >
                  {repositoryName ?? worktree.repositoryId}
                </Link>
              ) : (
                (repositoryName ?? worktree.repositoryId)
              )}
            </dd>
          </div>
          {worktree.agentId ? (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Agent</dt>
              <dd className="font-mono text-sm">{worktree.agentId}</dd>
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase text-muted-foreground">Path</dt>
            <dd className="break-all font-mono text-sm" data-pw="worktree-detail-path">
              {worktree.path}
            </dd>
          </div>
          {repoPath ? (
            <div className="sm:col-span-2">
              <dt className="text-xs uppercase text-muted-foreground">Repository path</dt>
              <dd className="break-all font-mono text-sm">{repoPath}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Status</dt>
            <dd>{worktree.status ? <StatusBadge status={worktree.status} /> : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Online</dt>
            <dd>
              {worktree.online === undefined ? (
                "—"
              ) : (
                <StatusBadge status={String(worktree.online)} />
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase text-muted-foreground">Labels</dt>
            <dd className="text-sm">
              {(worktree.labels ?? []).length ? (worktree.labels ?? []).join(", ") : "—"}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
