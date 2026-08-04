import type { ReactNode } from "react";
import Link from "next/link";

import { StatusBadge } from "./status-badge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";

export type WorktreeRow = {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  agentId?: string;
  labels?: string[];
};

export type WorktreeRepoGroup = {
  repositoryId: string;
  /** Catalog name; falls back to repositoryId when unknown (e.g. deleted catalog entry). */
  repositoryName?: string;
  /** Optional host path for the repo root. */
  repoPath?: string;
  /** When set, the repo name links to `${repoHrefBase}/${encodeURIComponent(repositoryId)}`. */
  repoHrefBase?: string;
  worktrees: WorktreeRow[];
};

export type WorktreesHierarchyProps = {
  groups: WorktreeRepoGroup[];
  showAgent?: boolean;
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
  showAgent = false,
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
    <div className="space-y-6" data-pw="worktrees-hierarchy">
      {groups.map((g) => (
        <section
          key={g.repositoryId}
          className="space-y-3 rounded-lg border border-border p-4"
          data-pw={`worktree-group-${g.repositoryId}`}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h3 className="text-base font-semibold">
                {g.repoHrefBase ? (
                  <Link
                    href={`${g.repoHrefBase}/${encodeURIComponent(g.repositoryId)}`}
                    className="hover:underline"
                  >
                    {g.repositoryName ?? g.repositoryId}
                  </Link>
                ) : (
                  (g.repositoryName ?? g.repositoryId)
                )}
              </h3>
              {g.repoPath ? (
                <p className="break-all font-mono text-xs text-muted-foreground">{g.repoPath}</p>
              ) : null}
            </div>
            {renderRepoActions?.(g)}
          </div>
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
                  {showAgent ? <TableHead>agent</TableHead> : null}
                  <TableHead>labels</TableHead>
                  {renderWorktreeActions ? <TableHead /> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {g.worktrees.map((wt) => (
                  <TableRow key={wt.id} data-pw={`worktree-row-${wt.id}`}>
                    <TableCell className="text-xs">
                      {hrefBase ? (
                        <Link
                          href={`${hrefBase}/${encodeURIComponent(wt.id)}`}
                          className="hover:underline"
                          data-pw={`worktree-link-${wt.id}`}
                        >
                          {wt.name}
                        </Link>
                      ) : (
                        wt.name
                      )}
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-mono text-xs">{wt.path}</TableCell>
                    <TableCell>{wt.status ? <StatusBadge status={wt.status} /> : "—"}</TableCell>
                    <TableCell>
                      {wt.online === undefined ? "—" : <StatusBadge status={String(wt.online)} />}
                    </TableCell>
                    {showAgent ? (
                      <TableCell className="font-mono text-xs">{wt.agentId ?? "—"}</TableCell>
                    ) : null}
                    <TableCell className="text-xs">
                      {(wt.labels ?? []).length ? (wt.labels ?? []).join(", ") : "—"}
                    </TableCell>
                    {renderWorktreeActions ? (
                      <TableCell className="text-right">{renderWorktreeActions(wt, g)}</TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
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
