"use client";

import { useState } from "react";
import { apiErrorMessage } from "@auto-harness/shared";
import { WorktreesHierarchy, type WorktreeRepoGroup } from "@auto-harness/ui";
import { Alert, Button } from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";
import {
  dedupeRepositories,
  repositoryPagePath,
  type RepositoryPage,
} from "../lib/repository-catalog.ts";
import { AddRepoDialog } from "./add-repo-dialog.tsx";
import { AttachLocalRepoForm } from "./attach-local-repo-form.tsx";
import { PrimaryEmptyState } from "./primary-empty-state.tsx";

type Repo = {
  id: string;
  name: string;
  url: string;
  defaultBranch?: string;
  sessionCount: number;
  worktreeCount: number;
  scheduleCount: number;
};
type Wt = {
  id: string;
  name: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  hostId?: string;
  labels?: string[];
};

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export function RepositoryPageClient({
  initialItems,
  initialNextCursor,
  initialPath,
  attachRepositories,
  hostIds,
  worktrees,
  canWriteInventory,
  canWriteCatalog,
}: Readonly<{
  initialItems: Repo[];
  initialNextCursor: string | null;
  initialPath: string;
  /** The attach picker is deliberately complete even while the visible list is paged. */
  attachRepositories: Repo[];
  hostIds: string[];
  worktrees: Wt[];
  canWriteInventory: boolean;
  canWriteCatalog: boolean;
}>) {
  const [items, setItems] = useState(initialItems);
  const [nextCursor, setNextCursor] = useState(initialNextCursor);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadError(null);
    try {
      const response = await apiFetch(repositoryPagePath(nextCursor, initialPath));
      if (!response.ok) throw new Error(await apiErrorMessage(response));
      const page = (await response.json()) as RepositoryPage<Repo>;
      setItems((current) => dedupeRepositories([...current, ...(page.items ?? [])]));
      setNextCursor(page.nextCursor ?? null);
    } catch (reason) {
      setLoadError(errorMessage(reason));
    } finally {
      setLoadingMore(false);
    }
  }

  const worktreesByRepo = new Map<string, Wt[]>();
  for (const wt of worktrees) {
    const list = worktreesByRepo.get(wt.repositoryId) ?? [];
    list.push(wt);
    worktreesByRepo.set(wt.repositoryId, list);
  }
  const groups: WorktreeRepoGroup[] = items.map((repo) => ({
    repositoryId: repo.id,
    repositoryName: repo.name,
    repoHrefBase: "/repositories",
    repoUrl: repo.url,
    defaultBranch: repo.defaultBranch ?? "main",
    sessionCount: repo.sessionCount,
    worktreeCount: repo.worktreeCount,
    scheduleCount: repo.scheduleCount,
    worktrees: worktreesByRepo.get(repo.id) ?? [],
  }));

  return (
    <>
      {groups.length === 0 ? (
        <div data-pw="worktrees-empty">
          <PrimaryEmptyState title="No repositories configured." pw="repositories-empty">
            <p>Register a catalog repository before attaching it to a host.</p>
            {canWriteCatalog ? (
              <AddRepoDialog
                triggerLabel="Add one →"
                triggerPw="repositories-empty-add"
                dialogPw="repositories-empty-dialog"
              />
            ) : null}
          </PrimaryEmptyState>
        </div>
      ) : (
        <WorktreesHierarchy
          groups={groups}
          showHost
          hrefBase="/worktrees"
          emptyMessage="No repositories registered yet."
        />
      )}

      {nextCursor ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            data-pw="repositories-load-more"
            onClick={() => void loadMore()}
          >
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      {loadError ? (
        <Alert
          variant="warning"
          role="alert"
          data-pw="repositories-load-more-error"
          className="flex items-center justify-between gap-3"
        >
          <span>Could not load more repositories ({loadError}).</span>
          <button
            type="button"
            className="font-medium underline"
            data-pw="repositories-load-more-retry"
            onClick={() => void loadMore()}
          >
            Retry
          </button>
        </Alert>
      ) : null}

      {canWriteInventory ? (
        <div className="border-t border-border pt-6">
          <h3 className="mb-2 text-lg font-medium">Attach a repository to a host</h3>
          <AttachLocalRepoForm hostIds={hostIds} repos={attachRepositories} />
        </div>
      ) : null}
    </>
  );
}
