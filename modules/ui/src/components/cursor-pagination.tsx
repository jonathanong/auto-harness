import Link from "next/link";

import { cn } from "../lib/utils.ts";

export type CursorPaginationProps = {
  /** URL for next page (omit or null when no more). */
  nextHref: string | null;
  /** Optional previous page URL (first page has none). */
  prevHref?: string | null;
  className?: string;
};

/** Link-based cursor pager (server-friendly; no client state). */
export function CursorPagination({ nextHref, prevHref, className }: CursorPaginationProps) {
  if (!nextHref && !prevHref) {
    return null;
  }
  return (
    <nav
      className={cn("flex items-center justify-between gap-3", className)}
      data-pw="cursor-pagination"
      aria-label="Pagination"
    >
      {prevHref ? (
        <Link
          href={prevHref}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          data-pw="pagination-prev"
        >
          ← Previous
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground" data-pw="pagination-prev-disabled">
          ← Previous
        </span>
      )}
      {nextHref ? (
        <Link
          href={nextHref}
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          data-pw="pagination-next"
        >
          Next →
        </Link>
      ) : (
        <span className="text-sm text-muted-foreground" data-pw="pagination-next-disabled">
          Next →
        </span>
      )}
    </nav>
  );
}
