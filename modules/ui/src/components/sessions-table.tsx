"use client";

import Link from "next/link";

import { Badge } from "./badge.tsx";
import { SessionPrompt } from "./session-prompt.tsx";
import { SessionCreatedTime, SessionDuration, useSessionClock } from "./session-time.tsx";
import { SessionStatusCell } from "./session-status-cell.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";

export type SessionRow = {
  id: string;
  status: string;
  repositoryId?: string | null;
  prompt?: string | null;
  targetLabel?: string | null;
  targetLabels?: string[] | null;
  target?: { providerId?: string; commandId?: string } | null;
  fallbacks?: Array<{ providerId?: string; commandId?: string }> | null;
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
  source?: string | null;
  priority?: number | null;
  requiredLabels?: string[] | null;
  concurrencyId?: string | null;
  hostId?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
};

export type SessionsTableProps = {
  items: SessionRow[];
  /** Show hostId column (control plane fleet view). */
  showHost?: boolean;
  emptyMessage?: string;
  /** When set, the session id links to `${hrefBase}/${encodeURIComponent(id)}`. */
  hrefBase?: string;
  /** Client-side search over the rows loaded on this page only. */
  search?: string;
};

/** Shared sessions table for control plane and host pane. */
export function SessionsTable({
  items,
  showHost = false,
  emptyMessage = "No sessions match filters.",
  hrefBase,
  search = "",
}: SessionsTableProps) {
  const needle = search.trim().toLowerCase();
  const visibleItems = needle
    ? items.filter((session) =>
        [
          session.id,
          session.prompt,
          session.concurrencyId,
          session.targetLabel,
          ...(session.targetLabels ?? []),
          ...(session.requiredLabels ?? []),
        ]
          .filter((value): value is string => Boolean(value))
          .some((value) => value.toLowerCase().includes(needle)),
      )
    : items;
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
          <TableHead>Priority</TableHead>
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
