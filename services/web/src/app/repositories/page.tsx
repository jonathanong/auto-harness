import { RepositoriesTable, WorktreesHierarchy, groupWorktreesByRepo } from "@auto-harness/ui";

import { AddRepoDialog } from "../../components/add-repo-dialog.tsx";
import { AttachLocalRepoForm } from "../../components/attach-local-repo-form.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

type Repo = { id: string; name: string; url: string; defaultBranch?: string };
type Host = { agentId: string };
type Wt = {
  id: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  agentId?: string;
  labels?: string[];
};

export default async function RepositoriesPage() {
  let items: Repo[] = [];
  let agentIds: string[] = [];
  let worktrees: Wt[] = [];
  let error: string | null = null;
  try {
    const [repos, hosts, wts] = await Promise.all([
      apiGet<{ items: Repo[] }>("/api/v1/repositories"),
      apiGet<{ items: Host[] }>("/api/v1/agents"),
      apiGet<{ items: Wt[] }>("/api/v1/worktrees"),
    ]);
    items = repos.items ?? [];
    agentIds = (hosts.items ?? []).map((h) => h.agentId);
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
            Catalog repositories and attach local paths to hosts.
          </p>
        </div>
        <AddRepoDialog />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <RepositoriesTable items={items} />

      <div>
        <h3 className="mb-2 text-lg font-medium">Register local repo on a host</h3>
        <AttachLocalRepoForm agentIds={agentIds} />
      </div>

      <div className="border-t border-border pt-6">
        <h3 className="mb-2 text-lg font-medium">Worktrees by repository</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          Click a worktree to see its details and sessions. Worktrees are managed on each agent pane
          (or fleet-wide on Worktrees).
        </p>
        <WorktreesHierarchy
          groups={groupWorktreesByRepo(worktrees)}
          showAgent
          hrefBase="/worktrees"
          emptyMessage="No worktrees registered yet."
        />
      </div>
    </div>
  );
}
