"use client";

import Link from "next/link";
import type { SessionListQuery } from "@auto-harness/shared";

import { Badge } from "./badge.tsx";
import { SessionPrompt } from "./session-prompt.tsx";
import { SessionPrioritySortHead } from "./session-priority-sort-head.tsx";
import { sessionMatchesSearch, type SearchableSession } from "./session-search.ts";
import { SessionCreatedTime, SessionDuration, useSessionClock } from "./session-time.tsx";
import { SessionStatusCell } from "./session-status-cell.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";

export type SessionRow = SearchableSession;

export type SessionsTableProps = {
  items: SessionRow[];
  /** Show hostId column (control plane fleet view). */
  showHost?: boolean;
  emptyMessage?: string;
  /** When set, the session id links to `${hrefBase}/${encodeURIComponent(id)}`. */
  hrefBase?: string;
  /** Client-side search over the rows loaded on this page only. */
  search?: string;
  /** Current server-backed list ordering. */
  sort?: SessionListQuery["sort"];
  /** URL for toggling the rendered Priority column's server-backed ordering. */
  prioritySortHref?: string;
};

/** Shared sessions table for control plane and host pane. */
export function SessionsTable({
  items,
  showHost = false,
  emptyMessage = "No sessions match filters.",
  hrefBase,
  search = "",
  sort = "latest",
  prioritySortHref,
}: SessionsTableProps) {
  const visibleItems = items.filter((session) => sessionMatchesSearch(session, search));
  const nowMs = useSessionClock(visibleItems.some((session) => session.status === "running"));
  const cols = showHost ? 12 : 11;
  return (
    <Table data-pw="sessions-table">
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Status</TableHead>
          {showHost ? <TableHead>Host</TableHead> : null}
          <TableHead>Route</TableHead>
          <TableHead>Queue expiry</TableHead>
          <TableHead>Prompt</TableHead>
          <TableHead>Source</TableHead>
          <SessionPrioritySortHead sort={sort} href={prioritySortHref} />
          <TableHead>Created</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Labels</TableHead>
          <TableHead>Concurrency ID</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visibleItems.map((s) => (
          <TableRow key={s.id} data-pw={`session-row-${s.id}`}>
            <TableCell className="font-mono text-xs">
              {hrefBase ? (
                <Link
                  href={`${hrefBase}/${encodeURIComponent(s.id)}`}
                  className="hover:underline"
                  data-pw={`session-link-${s.id}`}
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
            <TableCell>{s.source ?? "—"}</TableCell>
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
