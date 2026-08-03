import { emptyHostInventory, type HostInventory } from "@auto-harness/shared";
import { RepositoriesTable } from "@auto-harness/ui";

import { HostConfigForm } from "../../components/host-config-form.tsx";
import { AddRepoForm } from "../../components/host-inventory-add-repo.tsx";
import { agentId } from "../../lib/api.ts";
import { loadHostInventory } from "../../lib/inventory.ts";

export const dynamic = "force-dynamic";

export default async function AgentRepositoriesPage() {
  const id = agentId();
  const inventory = await loadHostInventory(id);
  const rows = inventory.repositories.map((r) => ({
    id: r.id,
    name: r.id,
    path: r.path,
    defaultBranch: r.defaultBranch,
  }));
  const initialJson = JSON.stringify(
    { repositories: inventory.repositories, commandProfiles: inventory.commandProfiles },
    null,
    2,
  );

  return (
    <div className="mx-auto max-w-2xl space-y-8" data-pw="page-repositories">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="repositories-heading">
          Repositories
        </h2>
        <p className="text-sm text-muted-foreground">
          Agent <code className="font-mono">{id}</code>. Add host repository paths here. Worktrees
          are configured on the Worktrees page.
        </p>
      </div>
      <AddRepoForm agentId={id} inventory={inventory} />
      <RepositoriesTable
        items={rows}
        pathLabel="Host path"
        emptyMessage="No repositories on this agent yet."
      />
      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Advanced: raw host inventory JSON</h3>
        <p className="text-sm text-muted-foreground">
          Power-user edit of full inventory (profiles, bulk worktrees). Prefer the forms when
          possible.
        </p>
        <HostConfigForm agentId={id} initialJson={initialJson || JSON.stringify(emptyHostInventory(), null, 2)} />
      </div>
    </div>
  );
}
