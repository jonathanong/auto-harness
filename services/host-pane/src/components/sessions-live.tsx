"use client";

import { PaginatedSessions, type SessionRow } from "@auto-harness/ui";
import type { SessionListQuery } from "@auto-harness/shared";

function fetchPage(path: string): Promise<Response> {
  return fetch(path, { credentials: "same-origin" });
}

export function SessionsLive({
  initialItems,
  initialNextCursor,
  path,
  listState,
  repositoryNames,
  prioritySortHref,
  createdSortHref,
}: {
  initialItems: SessionRow[];
  initialNextCursor: string | null;
  path: string;
  listState: SessionListQuery;
  repositoryNames: Readonly<Record<string, string>>;
  prioritySortHref: string;
  createdSortHref: string;
}) {
  return (
    <PaginatedSessions
      initialItems={initialItems}
      initialNextCursor={initialNextCursor}
      path={path}
      fetchPage={fetchPage}
      hrefBase="/sessions"
      search={listState.q}
      sort={listState.sort}
      sortHrefs={{ priority: prioritySortHref, created: createdSortHref }}
      repositoryHrefBase="/repositories"
      repositoryNames={repositoryNames}
      emptyMessage="No sessions for this agent."
    />
  );
}
