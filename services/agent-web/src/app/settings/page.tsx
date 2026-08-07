import { emptyHostInventory } from "@auto-harness/shared";
import { DrainButton } from "@auto-harness/ui";

import { HostConfigForm } from "../../components/host-config-form.tsx";
import { agentId } from "../../lib/api.ts";
import { loadHostInventory } from "../../lib/inventory.ts";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const id = agentId();
  const inventory = await loadHostInventory(id);
  const initialJson = JSON.stringify(
    {
      repositories: inventory.repositories,
      commandProfiles: inventory.commandProfiles,
      ...(inventory.logLevel !== undefined ? { logLevel: inventory.logLevel } : {}),
    },
    null,
    2,
  );

  return (
    <div className="space-y-8" data-pw="page-settings">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="settings-heading">
          Settings
        </h2>
        <p className="text-sm text-muted-foreground">
          Host-level controls for agent <code className="font-mono">{id}</code>.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-lg font-medium">Drain</h3>
        <p className="text-sm text-muted-foreground">
          Stop accepting new sessions. Running sessions finish; idle worktrees go offline.
        </p>
        <DrainButton
          agentId={id}
          label="Drain this host"
          pendingLabel="Draining…"
          pw="host-drain"
        />
      </div>

      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Advanced: raw host inventory JSON</h3>
        <p className="text-sm text-muted-foreground">
          Power-user edit of full inventory (profiles, bulk worktrees). Prefer the forms on
          Repositories when possible.
        </p>
        <HostConfigForm
          agentId={id}
          initialJson={initialJson || JSON.stringify(emptyHostInventory(), null, 2)}
        />
      </div>
    </div>
  );
}
