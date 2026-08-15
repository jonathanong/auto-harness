import { useCallback, useEffect, useRef, useState } from "react";

import type { SessionRow } from "./sessions-table.tsx";

type SessionPage = { cursor: string; items: SessionRow[]; nextCursor: string | null };

type SessionPageFetcher = (path: string) => Promise<Response>;

export function usePaginatedSessions({
  initialItems,
  initialNextCursor,
  initialPollError,
  path,
  fetchPage,
  pollMs,
}: {
  initialItems: SessionRow[];
  initialNextCursor: string | null;
  initialPollError: string | null;
  path: string;
  fetchPage: SessionPageFetcher;
  pollMs?: number;
}) {
  const [pages, setPagesState] = useState<SessionPage[]>(() => [
    makePage(path, initialItems, initialNextCursor),
  ]);
  const [pollError, setPollError] = useState<string | null>(initialPollError);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pagesRef = useRef(pages);
  const pathRef = useRef(path);
  const generationRef = useRef(0);
  const pollRequestRef = useRef(0);
  const loadRequestRef = useRef(0);
  const pollingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  pathRef.current = path;

  const setPages = useCallback((update: (current: SessionPage[]) => SessionPage[]) => {
    setPagesState((current) => {
      const next = update(current);
      pagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    generationRef.current += 1;
    pollRequestRef.current += 1;
    loadRequestRef.current += 1;
    pollingRef.current = false;
    loadingMoreRef.current = false;
    const next = makePage(path, initialItems, initialNextCursor);
    pagesRef.current = [next];
    setPagesState([next]);
    setPollError(initialPollError);
    setLoadError(null);
    setLoadingMore(false);
  }, [initialItems, initialNextCursor, initialPollError, path]);

  const refresh = useCallback(async () => {
    if (pollingRef.current) return;
    const requestId = pollRequestRef.current + 1;
    pollRequestRef.current = requestId;
    pollingRef.current = true;
    const generation = generationRef.current;
    const snapshot = pagesRef.current;
    try {
      const refreshed = await Promise.all(
        snapshot.map(
          async (page) =>
            [page.cursor, await requestPage(fetchPage, pagePath(path, page.cursor))] as const,
        ),
      );
      if (!isCurrent(generationRef, pollRequestRef, pathRef, generation, requestId, path)) return;
      const byCursor = new Map(refreshed);
      setPages((current) =>
        current.map((page) => {
          const next = byCursor.get(page.cursor);
          return next ? { ...next, cursor: page.cursor } : page;
        }),
      );
      setPollError(null);
    } catch (reason) {
      if (isCurrent(generationRef, pollRequestRef, pathRef, generation, requestId, path)) {
        setPollError(errorMessage(reason));
      }
    } finally {
      if (pollRequestRef.current === requestId) pollingRef.current = false;
    }
  }, [fetchPage, path, setPages]);

  const retryRefresh = useCallback(() => {
    pollingRef.current = false;
    return refresh();
  }, [refresh]);

  useEffect(() => {
    if (!pollMs) return;
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

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const cursor = pagesRef.current.at(-1)?.nextCursor;
    if (!cursor) return;
    const requestId = loadRequestRef.current + 1;
    loadRequestRef.current = requestId;
    loadingMoreRef.current = true;
    const generation = generationRef.current;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const loaded = await requestPage(fetchPage, pagePath(path, cursor));
      if (!isCurrent(generationRef, loadRequestRef, pathRef, generation, requestId, path)) return;
      setPages((current) => {
        if (current.some((page) => page.cursor === cursor)) return current;
        if (current.at(-1)?.nextCursor !== cursor) return current;
        return [...current, { ...loaded, cursor }];
      });
    } catch (reason) {
      if (isCurrent(generationRef, loadRequestRef, pathRef, generation, requestId, path)) {
        setLoadError(errorMessage(reason));
      }
    } finally {
      if (loadRequestRef.current === requestId) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [fetchPage, path, setPages]);

  return {
    items: dedupeSessions(pages.flatMap((page) => page.items)),
    nextCursor: pages.at(-1)?.nextCursor ?? null,
    pollError,
    loadError,
    loadingMore,
    loadMore,
    retryRefresh,
  };
}

async function requestPage(fetchPage: SessionPageFetcher, path: string) {
  const response = await fetchPage(path);
  if (!response.ok) throw new Error(`request failed (${response.status})`);
  const data = (await response.json()) as { items?: SessionRow[]; nextCursor?: string | null };
  return { items: data.items ?? [], nextCursor: data.nextCursor ?? null };
}

export function pagePath(path: string, cursor: string): string {
  const url = new URL(path, "http://auto-harness.local");
  if (cursor) url.searchParams.set("cursor", cursor);
  else url.searchParams.delete("cursor");
  return `${url.pathname}${url.search}`;
}

function makePage(path: string, items: SessionRow[], nextCursor: string | null): SessionPage {
  const cursor = new URL(path, "http://auto-harness.local").searchParams.get("cursor") ?? "";
  return { cursor, items, nextCursor };
}

export function dedupeSessions(items: SessionRow[]): SessionRow[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function isCurrent(
  generationRef: { current: number },
  requestRef: { current: number },
  pathRef: { current: string },
  generation: number,
  requestId: number,
  path: string,
): boolean {
  return (
    generationRef.current === generation &&
    requestRef.current === requestId &&
    pathRef.current === path
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
