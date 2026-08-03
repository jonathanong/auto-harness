import { HostConfigForm } from "../../components/host-config-form.tsx";
import { apiBase } from "../../lib/api.ts";

export const dynamic = "force-dynamic";

export default async function HostConfigPage() {
  const id = process.env.HARNESS_AGENT_ID ?? process.env.NEXT_PUBLIC_HARNESS_AGENT_ID ?? "local-1";
  let initial = `{
  "repositories": [{
    "id": "demo",
    "path": "/ABS/PATH/TO/REPO",
    "defaultBranch": "main",
    "worktrees": [{ "id": "wt-1", "path": "/ABS/PATH/TO/REPO/.worktrees/wt-1", "labels": ["echo"] }]
  }],
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
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Host inventory</h2>
        <p className="text-sm text-muted-foreground">
          Paths and command profile argv for <code>{id}</code>. Stored on the control plane; the
          agent daemon bootstraps this on start.
        </p>
      </div>
      <HostConfigForm agentId={id} initialJson={initial} />
    </div>
  );
}
