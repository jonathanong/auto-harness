import Link from "next/link";
import type { SessionListQuery } from "@auto-harness/shared";

import { TableHead } from "./table.tsx";

/** Priority column heading with server-backed ascending/descending links. */
export function SessionPrioritySortHead({
  sort,
  href,
}: {
  sort: SessionListQuery["sort"];
  href?: string;
}) {
  const direction =
    sort === "priority_asc" ? "ascending" : sort === "priority_desc" ? "descending" : undefined;

  return (
    <TableHead aria-sort={href ? direction : undefined}>
      {href ? (
        <Link
          href={href}
          className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={
            sort === "priority_desc"
              ? "Sort by priority, low to high"
              : "Sort by priority, high to low"
          }
          data-pw="session-sort-priority"
        >
          Priority
          <span aria-hidden="true">
            {sort === "priority_asc" ? "↑" : sort === "priority_desc" ? "↓" : "↕"}
          </span>
        </Link>
      ) : (
        "Priority"
      )}
    </TableHead>
  );
}
