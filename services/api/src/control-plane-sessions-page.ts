import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";

export type ListSessionsPageQuery = {
  /** Page size (default 20, max 100). */
  limit?: number;
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string;
  hostId?: string;
  status?: string;
  q?: string;
};

export type ListSessionsPageResult = {
  items: PublicSession[];
  nextCursor: string | null;
};

function encodeSessionCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, "utf8").toString("base64url");
}

function decodeSessionCursor(cursor: string): { createdAt: string; id: string } | null {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const nl = raw.indexOf("\n");
  if (nl <= 0) {
    return null;
  }
  return { createdAt: raw.slice(0, nl), id: raw.slice(nl + 1) };
}

/**
 * Cursor page of sessions (newest first). Cursor is opaque; nextCursor null means last page.
 */
export function listSessionsPage(
  state: ControlPlaneState,
  query: ListSessionsPageQuery = {},
): ListSessionsPageResult {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  let rows = [...state.sessions.values()].toSorted(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
  );
  if (query.hostId) {
    rows = rows.filter((s) => s.hostId === query.hostId);
  }
  if (query.status && query.status !== "all") {
    rows = rows.filter((s) => s.status === query.status);
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    rows = rows.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q) ||
        s.targetLabel.toLowerCase().includes(q),
    );
  }
  if (query.cursor) {
    const c = decodeSessionCursor(query.cursor);
    if (c) {
      rows = rows.filter((s) => {
        const cmp = s.createdAt.localeCompare(c.createdAt);
        if (cmp < 0) {
          return true;
        }
        if (cmp > 0) {
          return false;
        }
        return s.id.localeCompare(c.id) < 0;
      });
    }
  }
  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page[page.length - 1];
  return {
    items: page.map((s) => toPublic(state, s)),
    nextCursor: hasMore && last ? encodeSessionCursor(last.createdAt, last.id) : null,
  };
}

export function listSessions(state: ControlPlaneState): PublicSession[] {
  return listSessionsPage(state, { limit: Number.MAX_SAFE_INTEGER }).items;
}
