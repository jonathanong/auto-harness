import { AgentWorktreesEditor } from "../../components/agent-worktrees-editor.tsx";
import { agentId } from "../../lib/api.ts";
import { loadHostInventory, loadLiveWorktreesById } from "../../lib/inventory.ts";

export const dynamic = "force-dynamic";

export default async function AgentWorktreesPage() {
  const id = agentId();
  const [inventory, liveById] = await Promise.all([
    loadHostInventory(id),
    loadLiveWorktreesById(id),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6" data-pw="page-worktrees">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="worktrees-heading">
          Worktrees
        </h2>
        <p className="text-sm text-muted-foreground">
          Hierarchical by repository. Add worktrees explicitly (id + absolute path). Status/online
          come from the control plane when the agent is registered.
        </p>
      </div>
      <AgentWorktreesEditor agentId={id} inventory={inventory} liveById={liveById} />
    </div>
  );
}
