import { AddRepoDialog } from "../../components/add-repo-dialog.tsx";
import { ListApiError } from "../../components/list-page-states.tsx";
import { RepositoryPageClient } from "../../components/repository-page-client.tsx";
import { apiGet } from "../../lib/api.ts";
import {
  loadAllRepositoryPages,
  repositoryPagePath,
  type RepositoryPage,
} from "../../lib/repository-catalog.ts";
import { can, loadPrincipal } from "../../lib/principal.ts";

export const dynamic = "force-dynamic";

type Repo = {
  id: string;
  name: string;
  url: string;
  defaultBranch?: string;
  sessionCount: number;
  worktreeCount: number;
  scheduleCount: number;
};
type Host = { hostId: string };
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

export default async function RepositoriesPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const rawSearchParams = await searchParams;
  const rawLimit = rawSearchParams.limit;
  const limit =
    typeof rawLimit === "string" && /^[1-9]\d*$/.test(rawLimit) && Number(rawLimit) <= 100
      ? Number(rawLimit)
      : undefined;
  const repositoryPath = repositoryPagePath(
    null,
    limit ? `/api/v1/repositories?limit=${limit}` : undefined,
  );
  const principal = await loadPrincipal();
  const canWriteCatalog = can(principal, "catalog:write");
  const canWriteInventory = can(principal, "fleet:inventory");
  let items: Repo[] = [];
  let reposNextCursor: string | null = null;
  let attachRepositories: Repo[] = [];
  let hostIds: string[] = [];
  let worktrees: Wt[] = [];
  let error: string | null = null;
  try {
    const [repos, hosts, wts] = await Promise.all([
      apiGet<RepositoryPage<Repo>>(repositoryPath),
      apiGet<{ items: Host[] }>("/api/v1/hosts"),
      apiGet<{ items: Wt[] }>("/api/v1/worktrees"),
    ]);
    items = repos.items ?? [];
    reposNextCursor = repos.nextCursor ?? null;
    attachRepositories = items;
    if (canWriteInventory && repos.nextCursor) {
      try {
        attachRepositories = await loadAllRepositoryPages(
          (path) => apiGet<RepositoryPage<Repo>>(path),
          repos,
          repositoryPath,
        );
      } catch {
        // Keep the first page and its continuation cursor usable. A transient preload failure
        // must not turn a successful catalog response into a blank/error repository page.
        attachRepositories = items;
      }
    }
    hostIds = (hosts.items ?? []).map((h) => h.hostId);
    worktrees = wts.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-8" data-pw="page-repositories">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight" data-pw="repositories-heading">
            Repositories
          </h2>
          <p className="text-sm text-muted-foreground">
            Catalog repositories and attach local paths to hosts. Click a repository to expand its
            worktrees, or a worktree to see its details and sessions.
          </p>
        </div>
        {canWriteCatalog ? <AddRepoDialog /> : null}
      </div>
      {error ? (
        <ListApiError resource="repositories" message={error} selector="repositories" />
      ) : (
        <RepositoryPageClient
          initialItems={items}
          initialNextCursor={reposNextCursor}
          initialPath={repositoryPath}
          attachRepositories={attachRepositories}
          hostIds={hostIds}
          worktrees={worktrees}
          canWriteInventory={canWriteInventory}
          canWriteCatalog={canWriteCatalog}
        />
      )}
    </div>
  );
}
