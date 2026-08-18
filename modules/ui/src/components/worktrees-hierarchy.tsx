import type { ReactNode } from "react";
import Link from "next/link";

import { RepositoryUrlCopy } from "./repository-url-copy.tsx";
import { RepositoryObservabilityCounts } from "./repository-observability-counts.tsx";
import { OnlineStatusBadge } from "./online-status-badge.tsx";
import { WorktreeStatusBadge } from "./worktree-status-badge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";
import { WorktreeLabels } from "./worktree-labels.tsx";

export type WorktreeRow = {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  status?: string | undefined;
  online?: boolean | undefined;
  hostId?: string | undefined;
  labels?: string[] | undefined;
};

export type WorktreeRepoGroup = {
  repositoryId: string;
  /** Catalog name; falls back to repositoryId when unknown (e.g. deleted catalog entry). */
  repositoryName?: string;
  /** Catalog default branch, when this hierarchy represents catalog repositories. */
  defaultBranch?: string;
  /** Optional host path for the repo root. */
  repoPath?: string;
  /** Catalog Git URL; unlike a host path, this is rendered with an exact copy control. */
  repoUrl?: string;
  sessionCount?: number;
  worktreeCount?: number;
  scheduleCount?: number;
  /** When set, the repo name links to `${repoHrefBase}/${encodeURIComponent(repositoryId)}`. */
  repoHrefBase?: string;
  worktrees: WorktreeRow[];
};

export type WorktreesHierarchyProps = {
  groups: WorktreeRepoGroup[];
  showHost?: boolean;
  emptyMessage?: string;
  /** Optional node rendered under each repo header (e.g. add-worktree form). */
  renderRepoActions?: (group: WorktreeRepoGroup) => ReactNode;
  renderWorktreeActions?: (wt: WorktreeRow, group: WorktreeRepoGroup) => ReactNode;
  /** When set, the worktree id links to `${hrefBase}/${encodeURIComponent(id)}`. */
  hrefBase?: string;
};

/** Hierarchical worktrees: repository → worktrees table. */
export function WorktreesHierarchy({
  groups,
  showHost = false,
  emptyMessage = "No worktrees yet.",
  renderRepoActions,
  renderWorktreeActions,
  hrefBase,
}: WorktreesHierarchyProps) {
  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-pw="worktrees-empty">
        {emptyMessage}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-pw="worktrees-hierarchy">
      {groups.map((g) => (
        <details
          key={g.repositoryId}
          className="group rounded-lg border border-border"
          data-pw={`worktree-group-${g.repositoryId}`}
          open
        >
          <summary
            className="flex cursor-pointer list-none items-start justify-between gap-2 p-4 [&::-webkit-details-marker]:hidden"
            data-pw={`worktree-group-toggle-${g.repositoryId}`}
          >
            <div className="flex items-start gap-2">
              <svg
                viewBox="0 0 16 16"
                className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
                aria-hidden="true"
              >
                <path d="M5 2l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <div>
                <h3 className="text-base font-semibold">
                  {g.repoHrefBase ? (
                    <Link
                      href={`${g.repoHrefBase}/${encodeURIComponent(g.repositoryId)}`}
                      className="hover:underline"
                      data-pw={`repo-link-${g.repositoryId}`}
                    >
                      {g.repositoryName ?? g.repositoryId}
                    </Link>
                  ) : (
                    (g.repositoryName ?? g.repositoryId)
                  )}
                </h3>
                {g.repoUrl ? (
                  <RepositoryUrlCopy repositoryId={g.repositoryId} url={g.repoUrl} />
                ) : g.repoPath ? (
                  <p className="break-all font-mono text-xs text-muted-foreground">{g.repoPath}</p>
                ) : null}
                {g.defaultBranch ? (
                  <p
                    className="text-xs text-muted-foreground"
                    data-pw={`repo-default-branch-${g.repositoryId}`}
                  >
                    Default branch: <code className="font-mono">{g.defaultBranch}</code>
                  </p>
                ) : null}
              </div>
            </div>
            <RepositoryObservabilityCounts repository={g} />
          </summary>
          <div className="space-y-3 border-t border-border p-4">
            {renderRepoActions ? (
              <div className="flex justify-end">{renderRepoActions(g)}</div>
            ) : null}
            {g.worktrees.length === 0 ? (
              <p className="text-sm text-muted-foreground">No worktrees under this repository.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>name</TableHead>
                    <TableHead>path</TableHead>
                    <TableHead>status</TableHead>
                    <TableHead>online</TableHead>
                    {showHost ? <TableHead>host</TableHead> : null}
                    <TableHead>labels</TableHead>
                    {renderWorktreeActions ? <TableHead /> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {g.worktrees.map((wt) => (
                    <TableRow
                      key={wt.id}
                      className={hrefBase ? "relative cursor-pointer" : undefined}
                      data-pw={`worktree-row-${wt.id}`}
                    >
                      <TableCell className="text-xs">
                        {hrefBase ? (
                          <Link
                            href={`${hrefBase}/${encodeURIComponent(wt.id)}`}
                            className="after:absolute after:inset-0 hover:underline"
                            data-pw={`worktree-link-${wt.id}`}
                          >
                            {wt.name}
                          </Link>
                        ) : (
                          wt.name
                        )}
                      </TableCell>
                      <TableCell className="max-w-xs truncate font-mono text-xs">
                        {wt.path}
                      </TableCell>
                      <TableCell>
                        {wt.status ? <WorktreeStatusBadge status={wt.status} /> : "—"}
                      </TableCell>
                      <TableCell>
                        {wt.online === undefined ? (
                          "—"
                        ) : (
                          <OnlineStatusBadge online={wt.online} pw={`worktree-online-${wt.id}`} />
                        )}
                      </TableCell>
                      {showHost ? (
                        <TableCell className="font-mono text-xs">{wt.hostId ?? "—"}</TableCell>
                      ) : null}
                      <TableCell className="text-xs">
                        <WorktreeLabels labels={wt.labels} worktreeId={wt.id} />
                      </TableCell>
                      {renderWorktreeActions ? (
                        <TableCell className="relative z-10 text-right">
                          {renderWorktreeActions(wt, g)}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

/** Group flat worktree list by repositoryId. */
export function groupWorktreesByRepo(items: WorktreeRow[]): WorktreeRepoGroup[] {
  const map = new Map<string, WorktreeRow[]>();
  for (const wt of items) {
    const list = map.get(wt.repositoryId) ?? [];
    list.push(wt);
    map.set(wt.repositoryId, list);
  }
  return [...map.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([repositoryId, worktrees]) => ({ repositoryId, worktrees }));
}
