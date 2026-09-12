"use client";

import { SessionChildren, type SessionRow } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";

export function SessionChildrenLive({
  parentSessionId,
  initialItems,
  initialNextCursor,
  initialError = null,
  pollMs = 5_000,
}: {
  parentSessionId: string;
  initialItems: SessionRow[];
  initialNextCursor: string | null;
  initialError?: string | null;
  pollMs?: number;
}) {
  return (
    <SessionChildren
      initialItems={initialItems}
      initialNextCursor={initialNextCursor}
      initialPollError={initialError}
      path={`/api/v1/sessions/${encodeURIComponent(parentSessionId)}/children?limit=50`}
      fetchPage={(path) => apiFetch(path, { cache: "no-store" })}
      pollMs={pollMs}
    />
  );
}
