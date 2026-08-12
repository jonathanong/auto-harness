import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";
import { toPublic } from "./control-plane-state.ts";
import {
  decodeSessionCursor,
  encodeSessionCursor,
  normalizeLimit,
  normalizeQuery,
  normalizeScope,
  normalizeSort,
} from "./control-plane-session-cursor.ts";
import { compareSessionToCursor, compareSessions } from "./control-plane-session-order.ts";

export {
  InvalidSessionCursorError,
  InvalidSessionListQueryError,
  type ListSessionsPageQuery,
  type SessionListSort,
} from "./control-plane-session-cursor.ts";
import type { ListSessionsPageQuery } from "./control-plane-session-cursor.ts";

export type ListSessionsPageResult = {
  items: PublicSession[];
  nextCursor: string | null;
};

function matchesScope(session: SessionRecord, scope: ReturnType<typeof normalizeScope>): boolean {
  return (
    (scope.repositoryIds === null || scope.repositoryIds.includes(session.repositoryId)) &&
    (scope.hostId === null || session.hostId === scope.hostId)
  );
}

function matchesQuery(session: SessionRecord, query: ReturnType<typeof normalizeQuery>): boolean {
  return (
    (query.repositoryId === null || session.repositoryId === query.repositoryId) &&
    (query.status === null || session.status === query.status) &&
    (query.hostId === null || session.hostId === query.hostId) &&
    (query.concurrencyId === null || session.concurrencyId === query.concurrencyId) &&
    (query.scheduleId === null || session.scheduleId === query.scheduleId) &&
    (query.source === null || session.source === query.source)
  );
}

/** Cursor page of sessions. Scope and all filters are applied before slicing. */
export function listSessionsPage(
  state: ControlPlaneState,
  query: ListSessionsPageQuery = {},
  records: readonly SessionRecord[] = [...state.sessions.values()],
): ListSessionsPageResult {
  const limit = normalizeLimit(query.limit);
  const sort = normalizeSort(query.sort);
  const normalizedQuery = normalizeQuery(query);
  const normalizedScope = normalizeScope(query.scope);
  const cursorBase = { version: 1 as const, sort, query: normalizedQuery, scope: normalizedScope };
  const position = query.cursor ? decodeSessionCursor(state, query.cursor, cursorBase) : undefined;
  let rows = records
    .filter((session) => matchesScope(session, normalizedScope))
    .filter((session) => matchesQuery(session, normalizedQuery))
    .toSorted((a, b) => compareSessions(a, b, sort));
  if (position) {
    rows = rows.filter((session) => compareSessionToCursor(session, position, sort) > 0);
  }
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  return {
    items: page.map((session) => toPublic(state, session)),
    nextCursor:
      hasMore && last
        ? encodeSessionCursor(state, {
            ...cursorBase,
            position: { createdAt: last.createdAt, id: last.id, priority: last.priority },
          })
        : null,
  };
}

export function listSessions(state: ControlPlaneState): PublicSession[] {
  return [...state.sessions.values()]
    .toSorted((a, b) => compareSessions(a, b, "latest"))
    .map((session) => toPublic(state, session));
}
