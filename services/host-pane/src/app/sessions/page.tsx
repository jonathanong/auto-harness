import { Suspense } from "react";
import { buildSessionsApiPath, parseSessionListQuery, sessionListHref } from "@auto-harness/shared";
import { CursorPagination, SessionFilters, SessionsTable } from "@auto-harness/ui";

import { hostId, apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

type Session = {
  id: string;
  status: string;
  repositoryId?: string;
  prompt?: string;
  targetLabel?: string;
  source?: string;
  hostId?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  errorCode?: string | null;
};

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = hostId();
  const raw = await searchParams;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") {
      sp.set(k, v);
    }
  }
  const filters = parseSessionListQuery(sp);

  let items: Session[] = [];
  let nextCursor: string | null = null;
  let error: string | null = null;
  try {
    const data = await apiGet<{ items: Session[]; nextCursor: string | null }>(
      buildSessionsApiPath(filters, { hostId: id }),
    );
    items = data.items ?? [];
    nextCursor = data.nextCursor ?? null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const nextHref = nextCursor
    ? sessionListHref({ ...filters, cursor: nextCursor }, "/sessions")
    : null;
  const prevHref = filters.cursor ? sessionListHref({ ...filters, cursor: "" }, "/sessions") : null;

  return (
    <div className="space-y-4" data-pw="page-sessions">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="sessions-heading">
          Sessions
        </h2>
        <p className="text-sm text-muted-foreground">
          Sessions for agent <code className="font-mono">{id}</code>.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading filters…</p>}>
        <SessionFilters />
      </Suspense>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <SessionsTable
        items={items}
        hrefBase="/sessions"
        emptyMessage="No sessions for this agent."
        search={filters.q}
      />
      <CursorPagination nextHref={nextHref} prevHref={prevHref} />
    </div>
  );
}
