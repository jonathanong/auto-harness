import { HostConfigForm } from "../../components/host-config-form.tsx";
import { HostInventoryEditor } from "../../components/host-inventory-editor.tsx";
import { agentId, apiBase } from "../../lib/api.ts";
import type { HostInventory } from "@auto-harness/shared";
import { emptyHostInventory } from "@auto-harness/shared";

export const dynamic = "force-dynamic";

export default async function HostConfigPage() {
  const id = agentId();
  let inventory: HostInventory = emptyHostInventory();
  let initialJson = JSON.stringify(inventory, null, 2);
  try {
    const res = await fetch(`${apiBase()}/api/v1/agents/${encodeURIComponent(id)}/config`, {
      cache: "no-store",
    });
    if (res.ok) {
      const cfg = (await res.json()) as Record<string, unknown>;
      const { agentId: _a, updatedAt: _u, ...rest } = cfg;
      inventory = {
        repositories: Array.isArray(rest.repositories)
          ? (rest.repositories as HostInventory["repositories"])
          : [],
        commandProfiles:
          rest.commandProfiles && typeof rest.commandProfiles === "object"
            ? (rest.commandProfiles as HostInventory["commandProfiles"])
            : emptyHostInventory().commandProfiles,
      };
      initialJson = JSON.stringify(
        { repositories: inventory.repositories, commandProfiles: inventory.commandProfiles },
        null,
        2,
      );
    }
  } catch {
    /* keep empty */
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8" data-pw="page-agent-config">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="agent-config-heading">
          Local repositories
        </h2>
        <p className="text-sm text-muted-foreground">
          Agent <code className="font-mono">{id}</code>. Add a repository (host path), then add
          worktrees under it with explicit ids and paths. Nothing is invented for you.
        </p>
      </div>
      <HostInventoryEditor agentId={id} inventory={inventory} />
      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Advanced: raw host inventory JSON</h3>
        <p className="text-sm text-muted-foreground">
          Optional power-user edit (command profiles, bulk edits).
        </p>
        <HostConfigForm agentId={id} initialJson={initialJson} />
      </div>
    </div>
  );
}
