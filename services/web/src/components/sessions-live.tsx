"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sessionListHref, type SessionListQuery } from "@auto-harness/shared";
import { CursorPagination, SessionsTable, type SessionRow } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";

export function SessionsLive({
  initialItems,
  initialError = null,
  initialNextCursor,
  listState,
  path,
  pollMs = 5_000,
}: {
  initialItems: SessionRow[];
  initialError?: string | null;
  initialNextCursor: string | null;
  listState: SessionListQuery;
  path: string;
  pollMs?: number;
}) {
  const [items, setItems] = useState(initialItems);
  const [error, setError] = useState<string | null>(initialError);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const refreshing = useRef(false);
  const currentPath = useRef(path);
  currentPath.current = path;
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const response = await apiFetch(path);
      if (!response.ok) throw new Error(`request failed (${response.status})`);
      const data = (await response.json()) as {
        items?: SessionRow[];
        nextCursor?: string | null;
      };
      if (currentPath.current !== path) return;
      setItems(data.items ?? []);
      setNextCursor(data.nextCursor ?? null);
      setError(null);
    } catch (reason) {
      if (currentPath.current !== path) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      refreshing.current = false;
    }
  }, [path]);

  useEffect(() => {
    setItems(initialItems);
    setNextCursor(initialNextCursor);
    setError(initialError);
  }, [initialError, initialItems, initialNextCursor, path]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refresh();
      if (active) timer = setTimeout(() => void poll(), pollMs);
    };
    timer = setTimeout(() => void poll(), pollMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [pollMs, refresh]);

  const nextHref = nextCursor ? sessionListHref({ ...listState, cursor: nextCursor }) : null;
  const prevHref = listState.cursor ? sessionListHref({ ...listState, cursor: "" }) : null;

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
        search={listState.q}
        emptyMessage="No sessions yet. Create your first session."
      />
      <CursorPagination nextHref={nextHref} prevHref={prevHref} />
    </div>
  );
}
