import Link from "next/link";
import type { SessionListQuery } from "@auto-harness/shared";

import { TableHead } from "./table.tsx";

/** Sortable session column heading backed by the server list order. */
export function SessionSortHead({
  kind,
  sort,
  href,
}: {
  kind: "created" | "priority";
  sort: SessionListQuery["sort"];
  href?: string | undefined;
}) {
  const active =
    kind === "created"
      ? sort === "latest" || sort === "oldest"
      : sort === "priority_desc" || sort === "priority_asc";
  const ascending = sort === "oldest" || sort === "priority_asc";
  const label = kind === "created" ? "Created" : "Priority";
  const nextLabel =
    kind === "created"
      ? `Sort by creation time, ${sort === "latest" ? "oldest" : "newest"} first`
      : `Sort by priority, ${sort === "priority_desc" ? "low" : "high"} to ${sort === "priority_desc" ? "high" : "low"}`;

  return (
    <TableHead aria-sort={href && active ? (ascending ? "ascending" : "descending") : undefined}>
      {href ? (
        <Link
          href={href}
          className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={nextLabel}
          data-pw={`session-sort-${kind}`}
        >
          {label}
          <span aria-hidden="true">{active ? (ascending ? "↑" : "↓") : "↕"}</span>
        </Link>
      ) : (
        label
      )}
    </TableHead>
  );
}
