import { AgentWorktreesEditor } from "../../components/agent-worktrees-editor.tsx";
import { agentId, apiGet } from "../../lib/api.ts";
import { loadHostInventory } from "../../lib/inventory.ts";

export const dynamic = "force-dynamic";

type PlaneWt = {
  id: string;
  repositoryId: string;
  path: string;
  status?: string;
  online?: boolean;
  agentId?: string;
};

export default async function AgentWorktreesPage() {
  const id = agentId();
  const inventory = await loadHostInventory(id);
  let planeWts: PlaneWt[] = [];
  try {
    const data = await apiGet<{ items: PlaneWt[] }>("/api/v1/worktrees");
    planeWts = (data.items ?? []).filter((w) => w.agentId === id);
  } catch {
    /* ignore */
  }
  const liveById: Record<string, { id: string; status?: string; online?: boolean }> = {};
  for (const w of planeWts) {
    liveById[w.id] = { id: w.id, status: w.status, online: w.online };
  }

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
