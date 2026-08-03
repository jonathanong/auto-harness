import { Suspense } from "react";
import { buildSessionsApiPath, parseSessionListQuery, sessionListHref } from "@auto-harness/shared";
import { CursorPagination, SessionsTable } from "@auto-harness/ui";

import { SessionFilters } from "../../components/session-filters.tsx";
import { agentId, apiGet } from "../../lib/api.ts";

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

export default async function AgentSessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = agentId();
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
      buildSessionsApiPath(filters, { agentId: id }),
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
          Sessions for agent <code className="font-mono">{id}</code> (cursor-paginated).
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading filters…</p>}>
        <SessionFilters />
      </Suspense>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <SessionsTable items={items} emptyMessage="No sessions for this agent." />
      <CursorPagination nextHref={nextHref} prevHref={prevHref} />
    </div>
  );
}
