import { Suspense } from "react";
import { buildSessionsApiPath, parseSessionListQuery, sessionListHref } from "@auto-harness/shared";
import { SessionFilters } from "@auto-harness/ui";

import { SessionsLive } from "../../components/sessions-live.tsx";
import { hostId, apiGet, apiGetAllPages } from "../../lib/api.ts";

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
type Repository = { id: string; name: string };

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
  let repositoryNames: Record<string, string> = {};
  let nextCursor: string | null = null;
  let error: string | null = null;
  try {
    const [sessions, repositories] = await Promise.all([
      apiGet<{ items: Session[]; nextCursor: string | null }>(
        buildSessionsApiPath(filters, { hostId: id }),
      ),
      apiGetAllPages<Repository>("/api/v1/repositories").catch(() => []),
    ]);
    items = sessions.items ?? [];
    nextCursor = sessions.nextCursor ?? null;
    repositoryNames = Object.fromEntries(
      repositories.map((repository) => [repository.id, repository.name]),
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const prioritySortHref = sessionListHref(
    {
      ...filters,
      cursor: "",
      sort: filters.sort === "priority_desc" ? "priority_asc" : "priority_desc",
    },
    "/sessions",
  );
  const createdSortHref = sessionListHref(
    {
      ...filters,
      cursor: "",
      sort: filters.sort === "latest" ? "oldest" : "latest",
    },
    "/sessions",
  );

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
      <SessionsLive
        initialItems={items}
        initialNextCursor={nextCursor}
        path={buildSessionsApiPath(filters, { hostId: id })}
        listState={filters}
        prioritySortHref={prioritySortHref}
        createdSortHref={createdSortHref}
        repositoryNames={repositoryNames}
      />
    </div>
  );
}
