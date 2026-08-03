import Link from "next/link";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.tsx";

export type RepositoryRow = {
  id: string;
  name?: string;
  url?: string;
  path?: string;
  defaultBranch?: string;
};

export type RepositoriesTableProps = {
  items: RepositoryRow[];
  emptyMessage?: string;
  /** Prefer path over url when both present. */
  pathLabel?: string;
  /** When set, the repository id links to `${hrefBase}/${encodeURIComponent(id)}`. */
  hrefBase?: string;
};

/** Shared repositories catalog / host-path table. */
export function RepositoriesTable({
  items,
  emptyMessage = "No repositories yet.",
  pathLabel = "URL / path",
  hrefBase,
}: RepositoriesTableProps) {
  return (
    <Table data-pw="repositories-table">
      <TableHeader>
        <TableRow>
          <TableHead>ID</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>{pathLabel}</TableHead>
          <TableHead>Branch</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((r) => (
          <TableRow key={r.id} data-pw={`repo-row-${r.id}`}>
            <TableCell className="font-mono text-xs">
              {hrefBase ? (
                <Link
                  href={`${hrefBase}/${encodeURIComponent(r.id)}`}
                  className="hover:underline"
                  data-pw={`repo-link-${r.id}`}
                >
                  {r.id}
                </Link>
              ) : (
                r.id
              )}
            </TableCell>
            <TableCell>{r.name ?? "—"}</TableCell>
            <TableCell className="max-w-xs truncate font-mono text-xs">
              {r.path ?? r.url ?? "—"}
            </TableCell>
            <TableCell>{r.defaultBranch ?? "main"}</TableCell>
          </TableRow>
        ))}
        {items.length === 0 ? (
          <TableRow>
            <TableCell colSpan={4} className="text-muted-foreground">
              {emptyMessage}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
