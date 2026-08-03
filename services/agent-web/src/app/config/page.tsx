import { AddLocalRepoForm } from "../../components/add-local-repo-form.tsx";
import { HostConfigForm } from "../../components/host-config-form.tsx";
import { agentId, apiBase } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

export default async function HostConfigPage() {
  const id = agentId();
  let initial = `{
  "repositories": [],
  "commandProfiles": {
    "echo-prompt": { "argv": ["echo"], "appendPrompt": true }
  }
}`;
  try {
    const res = await fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(id)}/config`, {
      cache: "no-store",
    });
    if (res.ok) {
      const cfg = (await res.json()) as Record<string, unknown>;
      const { agentId: _a, updatedAt: _u, ...rest } = cfg;
      initial = JSON.stringify(rest, null, 2);
    }
  } catch {
    /* keep template */
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8" data-pw="page-agent-config">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="agent-config-heading">
          Local repositories
        </h2>
        <p className="text-sm text-muted-foreground">
          Flow: (1) start agent with env only → registers online, (2) add a local git path here →
          control plane catalog + host inventory, (3) agent reloads inventory and can take work.
        </p>
      </div>
      <div>
        <h3 className="mb-2 text-lg font-medium">Add local repo</h3>
        <AddLocalRepoForm agentId={id} />
      </div>
      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Advanced: raw host inventory JSON</h3>
        <p className="text-sm text-muted-foreground">
          Optional power-user edit of full inventory (profiles, multiple worktrees).
        </p>
        <HostConfigForm agentId={id} initialJson={initial} />
      </div>
    </div>
  );
}
