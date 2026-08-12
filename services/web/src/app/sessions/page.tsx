import { Suspense } from "react";
import Link from "next/link";
import { buildSessionsApiPath } from "@auto-harness/shared";
import { SessionFilters, WithTooltip } from "@auto-harness/ui";

import { SessionsLive } from "../../components/sessions-live.tsx";
import { ListApiError } from "../../components/list-page-states.tsx";
import { apiGet } from "../../lib/api.ts";
import { parseSessionListState } from "../../lib/url-state.ts";

export const dynamic = "force-dynamic";

type Session = {
  id: string;
  status: string;
  repositoryId?: string;
  prompt?: string;
  targetLabel?: string;
  source?: string;
  priority?: number;
  requiredLabels?: string[];
  hostId?: string | null;
  concurrencyId?: string | null;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
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
  const path = buildSessionsApiPath(filters);
  try {
    const data = await apiGet<{ items: Session[]; nextCursor: string | null }>(path);
    items = data.items ?? [];
    nextCursor = data.nextCursor ?? null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

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
      {error ? (
        <ListApiError resource="sessions" message={error} selector="sessions" />
      ) : (
        <SessionsLive
          initialItems={items}
          initialNextCursor={nextCursor}
          listState={filters}
          path={path}
        />
      )}
    </div>
  );
}
