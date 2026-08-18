import type { ReactNode } from "react";
import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "./card.tsx";
import { DetailHeader, type Crumb } from "./detail-header.tsx";
import { OnlineStatusBadge } from "./online-status-badge.tsx";
import { WorktreeStatusBadge } from "./worktree-status-badge.tsx";
import { WorktreeLabels } from "./worktree-labels.tsx";
import type { WorktreeRow } from "./worktrees-hierarchy.tsx";

export type WorktreeDetailProps = {
  worktree: WorktreeRow;
  breadcrumbs: Crumb[];
  /** Rendered in a row under the title (e.g. a remove button). */
  actions?: ReactNode;
  /** Tab content (Sessions/Settings) rendered below the header. */
  children?: ReactNode;
};

/** Shared worktree detail header — reused by the host pane and control page. */
export function WorktreeDetail({ worktree, breadcrumbs, actions, children }: WorktreeDetailProps) {
  return (
    <div className="space-y-6" data-pw="worktree-detail">
      <DetailHeader
        breadcrumbs={breadcrumbs}
        title={worktree.name}
        titlePw="worktree-detail-id"
        actions={actions}
      />
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
  /** When set, the agent field links to `${hostHrefBase}/${encodeURIComponent(hostId)}` (control plane only — the host pane has no per-host route). */
  hostHrefBase?: string;
};

/** Worktree fields — the Settings tab's content. */
export function WorktreeDetailsCard({
  worktree,
  repositoryName,
  repoHrefBase,
  repoPath,
  hostHrefBase,
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
          {worktree.hostId ? (
            <div>
              <dt className="text-xs uppercase text-muted-foreground">Host</dt>
              <dd className="font-mono text-sm">
                {hostHrefBase ? (
                  <Link
                    href={`${hostHrefBase}/${encodeURIComponent(worktree.hostId)}`}
                    className="hover:underline"
                  >
                    {worktree.hostId}
                  </Link>
                ) : (
                  worktree.hostId
                )}
              </dd>
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
            <dd>{worktree.status ? <WorktreeStatusBadge status={worktree.status} /> : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-muted-foreground">Online</dt>
            <dd>
              {worktree.online === undefined ? (
                "—"
              ) : (
                <OnlineStatusBadge online={worktree.online} pw="worktree-detail-online" />
              )}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase text-muted-foreground">Labels</dt>
            <dd className="text-sm">
              <WorktreeLabels labels={worktree.labels} worktreeId={worktree.id} />
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
