import { CursorPagination, WorktreesHierarchy, groupWorktreesByRepo } from "@auto-harness/ui";
import type { HostRepository } from "@auto-harness/shared";

import { attachmentsForRepo } from "../../components/add-worktree-attachments.ts";
import { AddWorktreeForRepo } from "../../components/add-worktree-for-repo.tsx";
import { apiGet, apiGetAllPages } from "../../lib/api.ts";
import { can, loadPrincipal } from "../../lib/principal.ts";

export const dynamic = "force-dynamic";

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
type Repo = { id: string; name: string };

export default async function WorktreesPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const raw = await searchParams;
  const cursor = typeof raw.cursor === "string" ? raw.cursor : null;
  const canWriteExecConfig = can(await loadPrincipal(), "fleet:exec-config");
  let items: Wt[] = [];
  let nextCursor: string | null = null;
  let namesById: Record<string, string> = {};
  let inventories: Array<{
    hostId: string;
    setupScript?: string;
    repositories?: HostRepository[];
  }> = [];
  let error: string | null = null;
  let inventoryError: string | null = null;
  try {
    const worktreesPath = `/api/v1/worktrees?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const [wts, repos] = await Promise.all([
      apiGet<{ items: Wt[]; nextCursor?: string | null }>(worktreesPath),
      apiGetAllPages<Repo>("/api/v1/repositories?limit=100"),
    ]);
    items = wts.items ?? [];
    nextCursor = wts.nextCursor ?? null;
    namesById = Object.fromEntries(repos.map((r) => [r.id, r.name]));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  try {
    inventories =
      (
        await apiGet<{
          items: Array<{ hostId: string; setupScript?: string; repositories?: HostRepository[] }>;
        }>("/api/v1/host-inventories?limit=100")
      ).items ?? [];
  } catch (e) {
    inventoryError = e instanceof Error ? e.message : String(e);
  }

  const groups = groupWorktreesByRepo(
    items.map((w) => ({
      id: w.id,
      name: w.name,
      repositoryId: w.repositoryId,
      path: w.path,
      status: w.status,
      online: w.online,
      hostId: w.hostId,
      labels: w.labels,
    })),
  ).map((g) => ({
    ...g,
    repositoryName: namesById[g.repositoryId] ?? g.repositoryId,
    repoHrefBase: "/repositories",
  }));

  return (
    <div className="space-y-4" data-pw="page-worktrees">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="worktrees-heading">
          Worktrees
        </h2>
        <p className="text-sm text-muted-foreground">
          Fleet worktrees grouped by repository. Add a worktree on a host that already has the
          repository attached.
        </p>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <WorktreesHierarchy
        groups={groups}
        showHost
        hrefBase="/worktrees"
        emptyMessage="No worktrees registered yet."
        renderRepoActions={(group) =>
          inventoryError ? (
            <p className="text-xs text-red-700">Unable to load host inventories.</p>
          ) : (
            <AddWorktreeForRepo
              repositoryId={group.repositoryId}
              repositoryName={group.repositoryName ?? group.repositoryId}
              attachments={attachmentsForRepo(inventories, group.repositoryId)}
              canWriteExecConfig={canWriteExecConfig}
            />
          )
        }
      />
      <CursorPagination
        nextHref={nextCursor ? `/worktrees?cursor=${encodeURIComponent(nextCursor)}` : null}
      />
    </div>
  );
}
