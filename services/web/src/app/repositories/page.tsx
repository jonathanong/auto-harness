import { RepositoriesTable } from "@auto-harness/ui";

import { AttachLocalRepoForm } from "../../components/attach-local-repo-form.tsx";
import { RepoCreateForm } from "../../components/repo-create-form.tsx";
import { apiGet } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

type Repo = { id: string; name: string; url: string; defaultBranch?: string };
type Agent = { agentId: string };

export default async function RepositoriesPage() {
  let items: Repo[] = [];
  let agentIds: string[] = [];
  let error: string | null = null;
  try {
    const [repos, agents] = await Promise.all([
      apiGet<{ items: Repo[] }>("/api/v1/repositories"),
      apiGet<{ items: Agent[] }>("/api/v1/agents"),
    ]);
    items = repos.items ?? [];
    agentIds = (agents.items ?? []).map((a) => a.agentId);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  return (
    <div className="space-y-8" data-pw="page-repositories">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="repositories-heading">
          Repositories
        </h2>
        <p className="text-sm text-muted-foreground">
          Catalog repositories and attach local host paths to agents. Worktrees are managed on the
          agent pane Worktrees page (or control Worktrees for fleet view).
        </p>
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <RepositoriesTable items={items} />

      <div>
        <h3 className="mb-2 text-lg font-medium">Register local repo on an agent</h3>
        <AttachLocalRepoForm agentIds={agentIds} />
      </div>

      <div className="border-t border-border pt-6">
        <h3 className="mb-2 text-lg font-medium">Catalog only (no agent path)</h3>
        <p className="mb-2 text-sm text-muted-foreground">
          Creates a control-plane repository record without attaching host inventory.
        </p>
        <RepoCreateForm />
      </div>
    </div>
  );
}
