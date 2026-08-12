import type { SessionRecord } from "./db/types.ts";
import type { CursorPosition, SessionListSort } from "./control-plane-session-cursor.ts";

export function compareSessions(a: SessionRecord, b: SessionRecord, sort: SessionListSort): number {
  if (sort === "latest") {
    return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  }
  if (sort === "oldest") {
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  }
  if (sort === "priority_desc") {
    return (
      b.priority - a.priority || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    );
  }
  return (
    a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  );
}

export function compareSessionToCursor(
  session: SessionRecord,
  position: CursorPosition,
  sort: SessionListSort,
): number {
  if (sort === "latest") {
    return (
      position.createdAt.localeCompare(session.createdAt) || position.id.localeCompare(session.id)
    );
  }
  if (sort === "oldest") {
    return (
      session.createdAt.localeCompare(position.createdAt) || session.id.localeCompare(position.id)
    );
  }
  if (sort === "priority_desc") {
    return (
      position.priority - session.priority ||
      position.createdAt.localeCompare(session.createdAt) ||
      position.id.localeCompare(session.id)
    );
  }
  return (
    session.priority - position.priority ||
    session.createdAt.localeCompare(position.createdAt) ||
    session.id.localeCompare(position.id)
  );
}
