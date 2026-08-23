import { WorktreesHierarchy, type WorktreeRepoGroup } from "@auto-harness/ui";

import { AddRepoDialog } from "../../components/add-repo-dialog.tsx";
import { AttachLocalRepoForm } from "../../components/attach-local-repo-form.tsx";
import { ListApiError } from "../../components/list-page-states.tsx";
import { PrimaryEmptyState } from "../../components/primary-empty-state.tsx";
import { apiGet, apiGetAllPages } from "../../lib/api.ts";
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

export default async function RepositoriesPage() {
  const principal = await loadPrincipal();
  const canWriteCatalog = can(principal, "catalog:write");
  const canWriteInventory = can(principal, "fleet:inventory");
  let items: Repo[] = [];
  let hostIds: string[] = [];
  let worktrees: Wt[] = [];
  let error: string | null = null;
  try {
    const [repos, hosts, wts] = await Promise.all([
      apiGetAllPages<Repo>("/api/v1/repositories"),
      apiGet<{ items: Host[] }>("/api/v1/hosts"),
      apiGet<{ items: Wt[] }>("/api/v1/worktrees"),
    ]);
    items = repos;
    hostIds = (hosts.items ?? []).map((h) => h.hostId);
    worktrees = wts.items ?? [];
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const worktreesByRepo = new Map<string, Wt[]>();
  for (const wt of worktrees) {
    const list = worktreesByRepo.get(wt.repositoryId) ?? [];
    list.push(wt);
    worktreesByRepo.set(wt.repositoryId, list);
  }
  const groups: WorktreeRepoGroup[] = items.map((r) => ({
    repositoryId: r.id,
    repositoryName: r.name,
    repoHrefBase: "/repositories",
    repoUrl: r.url,
    defaultBranch: r.defaultBranch ?? "main",
    sessionCount: r.sessionCount,
    worktreeCount: r.worktreeCount,
    scheduleCount: r.scheduleCount,
    worktrees: worktreesByRepo.get(r.id) ?? [],
  }));

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

          {canWriteInventory ? (
            <div className="border-t border-border pt-6">
              <h3 className="mb-2 text-lg font-medium">Attach a repository to a host</h3>
              <AttachLocalRepoForm hostIds={hostIds} repos={items} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
