"use client";

import type { ReactNode } from "react";
import type { SessionListQuery } from "@auto-harness/shared";

import { Alert } from "./alert.tsx";
import { Button } from "./button.tsx";
import { SessionsTable, type SessionRow } from "./sessions-table.tsx";
import { usePaginatedSessions } from "./use-paginated-sessions.ts";

export type PaginatedSessionsProps = {
  initialItems: SessionRow[];
  initialNextCursor: string | null;
  initialPollError?: string | null;
  path: string;
  fetchPage: (path: string) => Promise<Response>;
  pollMs?: number;
  showHost?: boolean;
  emptyMessage?: string;
  emptyState?: ReactNode;
  hrefBase?: string;
  search?: string;
  repositoryNames?: Readonly<Record<string, string>>;
  repositoryHrefBase?: string;
  sort?: SessionListQuery["sort"];
  sortHrefs?: { priority?: string; created?: string };
};

/** Cursor-backed append-only session list shared by control and host panes. */
export function PaginatedSessions({
  initialItems,
  initialNextCursor,
  initialPollError = null,
  path,
  fetchPage,
  pollMs,
  showHost,
  emptyMessage,
  emptyState,
  hrefBase,
  search,
  repositoryNames,
  repositoryHrefBase,
  sort,
  sortHrefs,
}: PaginatedSessionsProps) {
  const { items, nextCursor, pollError, loadError, loadingMore, loadMore, retryRefresh } =
    usePaginatedSessions({
      initialItems,
      initialNextCursor,
      initialPollError,
      path,
      fetchPage,
      pollMs,
    });

  return (
    <div className="space-y-3">
      {pollMs ? (
        pollError ? (
          <Alert
            variant="warning"
            role="alert"
            data-pw="sessions-live-error"
            className="flex items-center justify-between gap-3"
          >
            <span>Live updates paused ({pollError}).</span>
            <button
              type="button"
              className="font-medium underline"
              onClick={() => void retryRefresh()}
            >
              Retry
            </button>
          </Alert>
        ) : (
          <p
            className="text-xs text-muted-foreground"
            data-pw="sessions-live-active"
            aria-live="polite"
          >
            Live updates active
          </p>
        )
      ) : null}
      {items.length === 0 && emptyState ? (
        emptyState
      ) : (
        <SessionsTable
          items={items}
          showHost={showHost}
          emptyMessage={emptyMessage}
          hrefBase={hrefBase}
          search={search}
          repositoryNames={repositoryNames}
          repositoryHrefBase={repositoryHrefBase}
          sort={sort}
          sortHrefs={sortHrefs}
        />
      )}
      {loadError ? (
        <Alert
          variant="warning"
          role="alert"
          data-pw="sessions-load-more-error"
          className="flex items-center justify-between gap-3"
        >
          <span>Could not load more sessions ({loadError}).</span>
          <button
            type="button"
            className="font-medium underline"
            data-pw="sessions-load-more-retry"
            onClick={() => void loadMore()}
          >
            Retry
          </button>
        </Alert>
      ) : null}
      {nextCursor ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            data-pw="sessions-load-more"
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
