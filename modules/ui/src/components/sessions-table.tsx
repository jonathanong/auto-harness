"use client";

import Link from "next/link";
import type { SessionListQuery } from "@auto-harness/shared";

import { Badge } from "./badge.tsx";
import { SessionPrompt } from "./session-prompt.tsx";
import { sessionMatchesSearch, type SearchableSession } from "./session-search.ts";
import { SessionSortHead } from "./session-sort-head.tsx";
import { SessionSourceBadge } from "./session-source-badge.tsx";
import { SessionCreatedTime, SessionDuration, useSessionClock } from "./session-time.tsx";
import { SessionStatusCell } from "./session-status-cell.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";
import { useSessionTableKeyboard } from "./use-session-table-keyboard.ts";
export type SessionRow = SearchableSession;

export type SessionsTableProps = {
  items: SessionRow[];
  /** Show hostId column (control plane fleet view). */
  showHost?: boolean | undefined;
  emptyMessage?: string | undefined;
  /** When set, the session id links to `${hrefBase}/${encodeURIComponent(id)}`. */
  hrefBase?: string | undefined;
  /** Client-side search over the rows loaded on this page only. */
  search?: string | undefined;
  /** Stable catalog labels keyed by repository id. */
  repositoryNames?: Readonly<Record<string, string>> | undefined;
  /** When set, repository ids link to this detail-route base. */
  repositoryHrefBase?: string | undefined;
  /** Current server-backed list ordering. */
  sort?: SessionListQuery["sort"] | undefined;
  sortHrefs?: { priority?: string; created?: string } | undefined;
};

/** Shared sessions table for control plane and host pane. */
export function SessionsTable({
  items,
  showHost = false,
  emptyMessage = "No sessions match filters.",
  hrefBase,
  search = "",
  repositoryNames = {},
  repositoryHrefBase,
  sort = "latest",
  sortHrefs = {},
}: SessionsTableProps) {
  const visibleItems = items.filter((session) =>
    sessionMatchesSearch(
      {
        ...session,
        repositoryName: session.repositoryId
          ? (repositoryNames[session.repositoryId] ?? session.repositoryName)
          : session.repositoryName,
      },
      search,
    ),
  );
  const nowMs = useSessionClock(visibleItems.some((session) => session.status === "running"));
  const cols = showHost ? 13 : 12;
  const { selectedId, setSelectedId } = useSessionTableKeyboard(
    visibleItems.map((session) => session.id),
    hrefBase,
  );
  return (
    <Table data-pw="sessions-table" aria-keyshortcuts="J K Enter">
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Repository</TableHead>
          {showHost ? <TableHead>Host</TableHead> : null}
          <TableHead>Route</TableHead>
          <TableHead>Queue expiry</TableHead>
          <TableHead>Prompt</TableHead>
          <TableHead>Source</TableHead>
          <SessionSortHead kind="priority" sort={sort} href={sortHrefs.priority} />
          <SessionSortHead kind="created" sort={sort} href={sortHrefs.created} />
          <TableHead>Duration</TableHead>
          <TableHead>Labels</TableHead>
          <TableHead>Concurrency ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleItems.map((s) => (
          <TableRow
            key={s.id}
            data-pw={`session-row-${s.id}`}
            data-session-row-id={s.id}
            aria-selected={selectedId === s.id}
            tabIndex={-1}
            className={selectedId === s.id ? "bg-muted ring-2 ring-inset ring-primary" : undefined}
            onClick={() => setSelectedId(s.id)}
          >
            <TableCell className="font-mono text-xs">
              {hrefBase ? (
                <Link
                  href={`${hrefBase}/${encodeURIComponent(s.id)}`}
                  className="hover:underline"
                  data-pw={`session-link-${s.id}`}
                  data-session-link-id={s.id}
                >
                  {s.id}
                </Link>
              ) : (
                s.id
              )}
            </TableCell>
            <TableCell>
              <SessionStatusCell status={s.status} errorCode={s.errorCode} sessionId={s.id} />
            </TableCell>
            <TableCell data-pw={`session-repository-${s.id}`}>
              {s.repositoryId ? (
                repositoryHrefBase ? (
                  <Link
                    href={`${repositoryHrefBase}/${encodeURIComponent(s.repositoryId)}`}
                    className="hover:underline"
                  >
                    {repositoryNames[s.repositoryId] ?? s.repositoryName ?? s.repositoryId}
                  </Link>
                ) : (
                  (repositoryNames[s.repositoryId] ?? s.repositoryName ?? s.repositoryId)
                )
              ) : (
                "—"
              )}
            </TableCell>
            {showHost ? (
              <TableCell className="font-mono text-xs">{s.hostId ?? "—"}</TableCell>
            ) : null}
            <TableCell>
              <div>{s.targetLabel ?? s.targetLabels?.[0] ?? routeLabel(s.target) ?? "—"}</div>
              {Math.max(s.fallbacks?.length ?? 0, Math.max((s.targetLabels?.length ?? 1) - 1, 0)) >
              0 ? (
                <div className="text-xs text-muted-foreground">
                  +
                  {Math.max(
                    s.fallbacks?.length ?? 0,
                    Math.max((s.targetLabels?.length ?? 1) - 1, 0),
                  )}{" "}
                  fallback
                  {Math.max(
                    s.fallbacks?.length ?? 0,
                    Math.max((s.targetLabels?.length ?? 1) - 1, 0),
                  ) === 1
                    ? ""
                    : "s"}
                </div>
              ) : null}
              {s.resolvedProviderAccountId ||
              s.resolvedCommandId ||
              s.resolvedHostId ||
              s.resolvedRoute ? (
                <div className="text-xs text-muted-foreground">
                  {s.resolvedRoute?.targetIndex != null
                    ? `target ${s.resolvedRoute.targetIndex + 1}: `
                    : null}
                  {s.resolvedProviderAccountId ?? s.resolvedRoute?.providerAccountId ?? "CLI"} /{" "}
                  {s.resolvedCommandId ?? s.resolvedRoute?.commandId ?? "—"} /{" "}
                  {s.resolvedHostId ?? s.resolvedRoute?.hostId ?? "—"}
                </div>
              ) : null}
            </TableCell>
            <TableCell className="whitespace-nowrap text-xs">{s.queueExpiresAt ?? "—"}</TableCell>
            <TableCell className="max-w-xs align-top">
              <SessionPrompt sessionId={s.id} prompt={s.prompt} />
            </TableCell>
            <TableCell>
              <SessionSourceBadge source={s.source} />
            </TableCell>
            <TableCell data-pw={`session-priority-${s.id}`}>{s.priority ?? 0}</TableCell>
            <TableCell className="whitespace-nowrap" data-pw={`session-created-${s.id}`}>
              <SessionCreatedTime value={s.createdAt} nowMs={nowMs} />
            </TableCell>
            <TableCell className="whitespace-nowrap" data-pw={`session-duration-${s.id}`}>
              <SessionDuration session={s} nowMs={nowMs} />
            </TableCell>
            <TableCell data-pw={`session-labels-${s.id}`}>
              {s.requiredLabels?.length ? (
                <div className="flex max-w-xs flex-wrap gap-1">
                  {s.requiredLabels.map((label) => (
                    <Badge key={label} variant="outline">
                      {label}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">Any</span>
              )}
            </TableCell>
            <TableCell className="max-w-xs truncate font-mono text-xs">
              {s.concurrencyId ?? "—"}
            </TableCell>
          </TableRow>
        ))}
        {visibleItems.length === 0 ? (
          <TableRow>
            <TableCell colSpan={cols} className="text-muted-foreground">
              {emptyMessage}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function routeLabel(target?: { providerId?: string; commandId?: string } | null): string | null {
  if (!target) return null;
  if (target.providerId) return `provider:${target.providerId}`;
  if (target.commandId) return `command:${target.commandId}`;
  return null;
}
