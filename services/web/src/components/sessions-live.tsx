"use client";

import { sessionListHref, type SessionListQuery } from "@auto-harness/shared";
import { PaginatedSessions, TipLink, type SessionRow } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";
import { PrimaryEmptyState } from "./primary-empty-state.tsx";

export function SessionsLive({
  initialItems,
  initialError = null,
  initialNextCursor,
  listState,
  path,
  repositoryNames = {},
  pollMs = 5_000,
}: {
  initialItems: SessionRow[];
  initialError?: string | null;
  initialNextCursor: string | null;
  listState: SessionListQuery;
  path: string;
  repositoryNames?: Readonly<Record<string, string>>;
  pollMs?: number;
}) {
  const prioritySortHref = sessionListHref({
    ...listState,
    cursor: "",
    sort: listState.sort === "priority_desc" ? "priority_asc" : "priority_desc",
  });
  const createdSortHref = sessionListHref({
    ...listState,
    cursor: "",
    sort: listState.sort === "latest" ? "oldest" : "latest",
  });
  const narrowed = Boolean(
    listState.q ||
    listState.concurrencyId ||
    listState.cursor ||
    listState.repositoryId ||
    listState.hostId ||
    listState.scheduleId ||
    listState.source ||
    listState.status !== "all",
  );

  return (
    <PaginatedSessions
      initialItems={initialItems}
      initialNextCursor={initialNextCursor}
      initialPollError={initialError}
      path={path}
      fetchPage={apiFetch}
      pollMs={pollMs}
      showHost
      hrefBase="/sessions"
      search={listState.q}
      sort={listState.sort}
      sortHrefs={{ priority: prioritySortHref, created: createdSortHref }}
      repositoryHrefBase="/repositories"
      repositoryNames={repositoryNames}
      emptyMessage={narrowed ? "No sessions match filters." : "No sessions yet."}
      emptyState={
        !narrowed ? (
          <PrimaryEmptyState title="No sessions yet." pw="sessions-empty">
            <p>Queue a one-off task to start using Auto Harness.</p>
            <TipLink
              href="/sessions/new"
              tip="Create a one-off session"
              pw="sessions-empty-create"
              className="font-medium text-primary hover:underline"
            >
              Create your first session →
            </TipLink>
          </PrimaryEmptyState>
        ) : undefined
      }
    />
  );
}
