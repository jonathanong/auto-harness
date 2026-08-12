"use client";

import { useCallback, useEffect, useState } from "react";
import { CursorPagination, SessionsTable, type SessionRow } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";

export function SessionsLive({
  initialItems,
  initialError = null,
  path,
  nextHref,
  prevHref,
  search,
  pollMs = 5_000,
}: {
  initialItems: SessionRow[];
  initialError?: string | null;
  path: string;
  nextHref: string | null;
  prevHref: string | null;
  search: string;
  pollMs?: number;
}) {
  const [items, setItems] = useState(initialItems);
  const [error, setError] = useState<string | null>(initialError);
  const refresh = useCallback(async () => {
    try {
      const response = await apiFetch(path);
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      const data = (await response.json()) as { items?: SessionRow[] };
      setItems(data.items ?? []);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [path]);
  useEffect(() => {
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  return (
    <div className="space-y-3">
      {error ? (
        <div
          role="alert"
          data-pw="sessions-live-error"
          className="flex items-center justify-between rounded-md border border-yellow-500/50 bg-yellow-50 p-3 text-sm"
        >
          <span>Live updates paused ({error}).</span>
          <button type="button" className="font-medium underline" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : (
        <p
          className="text-xs text-muted-foreground"
          data-pw="sessions-live-active"
          aria-live="polite"
        >
          Live updates active
        </p>
      )}
      <SessionsTable
        items={items}
        showHost
        hrefBase="/sessions"
        search={search}
        emptyMessage="No sessions yet. Create your first session."
      />
      <CursorPagination nextHref={nextHref} prevHref={prevHref} />
    </div>
  );
}
