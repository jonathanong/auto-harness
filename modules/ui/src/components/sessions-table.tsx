import Link from "next/link";

import { StatusBadge } from "./status-badge.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";

export type SessionRow = {
  id: string;
  status: string;
  repositoryId?: string | null;
  prompt?: string | null;
  commandProfile?: string | null;
  source?: string | null;
  agentId?: string | null;
  createdAt?: string | null;
};

export type SessionsTableProps = {
  items: SessionRow[];
  /** Show agentId column (control plane fleet view). */
  showAgent?: boolean;
  emptyMessage?: string;
  /** When set, the session id links to `${hrefBase}/${encodeURIComponent(id)}`. */
  hrefBase?: string;
};

/** Shared sessions table for control plane and agent pane. */
export function SessionsTable({
  items,
  showAgent = false,
  emptyMessage = "No sessions match filters.",
  hrefBase,
}: SessionsTableProps) {
  const cols = showAgent ? 6 : 5;
  return (
    <Table data-pw="sessions-table">
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Status</TableHead>
          {showAgent ? <TableHead>Agent</TableHead> : null}
          <TableHead>Profile</TableHead>
          <TableHead>Prompt</TableHead>
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((s) => (
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
              <StatusBadge status={s.status} />
            </TableCell>
            {showAgent ? (
              <TableCell className="font-mono text-xs">{s.agentId ?? "—"}</TableCell>
            ) : null}
            <TableCell>{s.commandProfile ?? "—"}</TableCell>
            <TableCell className="max-w-xs truncate">{s.prompt ?? "—"}</TableCell>
            <TableCell>{s.source ?? "—"}</TableCell>
          </TableRow>
        ))}
        {items.length === 0 ? (
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
