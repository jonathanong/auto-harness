"use client";

import { Card, CardContent } from "./card.tsx";
import { PaginatedSessions } from "./paginated-sessions.tsx";
import type { SessionRow } from "./sessions-table.tsx";

export type SessionChildrenProps = {
  initialItems: SessionRow[];
  initialNextCursor: string | null;
  initialPollError?: string | null;
  path: string;
  fetchPage: (path: string) => Promise<Response>;
  pollMs?: number;
};

/** Bounded, live direct-child list for a session detail view. */
export function SessionChildren({
  initialItems,
  initialNextCursor,
  initialPollError = null,
  path,
  fetchPage,
  pollMs = 5_000,
}: SessionChildrenProps) {
  return (
    <Card data-pw="session-detail-children">
      <CardContent className="space-y-3 pt-4">
        <div>
          <h3 className="text-sm font-medium">Child sessions</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Direct follow-up sessions spawned by this session.
          </p>
        </div>
        <PaginatedSessions
          initialItems={initialItems}
          initialNextCursor={initialNextCursor}
          initialPollError={initialPollError}
          path={path}
          fetchPage={fetchPage}
          pollMs={pollMs}
          hrefBase="/sessions"
          emptyMessage="No child sessions."
        />
      </CardContent>
    </Card>
  );
}
