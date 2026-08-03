import { Suspense } from "react";
import Link from "next/link";
import { buildSessionsApiPath } from "@auto-harness/shared";
import { CursorPagination, SessionFilters, SessionsTable, WithTooltip } from "@auto-harness/ui";

import { apiGet } from "../../lib/api.ts";
import { parseSessionListState, sessionListHref } from "../../lib/url-state.ts";

export const dynamic = "force-dynamic";

type Session = {
  id: string;
  status: string;
  repositoryId?: string;
  prompt?: string;
  commandProfile?: string;
  source?: string;
  agentId?: string | null;
};

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      sp.set(k, v);
    }
  }
  const filters = parseSessionListState(sp);

  let items: Session[] = [];
  let nextCursor: string | null = null;
  let error: string | null = null;
  try {
    const data = await apiGet<{ items: Session[]; nextCursor: string | null }>(
      buildSessionsApiPath(filters),
    );
    items = data.items ?? [];
    nextCursor = data.nextCursor ?? null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const nextHref = nextCursor ? sessionListHref({ ...filters, cursor: nextCursor }) : null;
  // Previous page is not encoded in cursor chain; only "first page" via clearing cursor.
  const prevHref = filters.cursor ? sessionListHref({ ...filters, cursor: "" }) : null;

  return (
    <div className="space-y-4" data-pw="page-sessions">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="sessions-heading">
          Sessions
        </h2>
        <WithTooltip tip="Create a one-off session">
          <Link
            href="/sessions/new"
            className="text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            New session
          </Link>
        </WithTooltip>
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading filters…</p>}>
        <SessionFilters />
      </Suspense>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <SessionsTable items={items} showAgent hrefBase="/sessions" />
      <CursorPagination nextHref={nextHref} prevHref={prevHref} />
    </div>
  );
}
