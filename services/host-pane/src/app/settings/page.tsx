import { type Command, type Provider, type ProviderAccount } from "@auto-harness/shared";
import { DrainButton, HostConfigForm, HostSetupScriptForm } from "@auto-harness/ui";

import { ProviderAccountsReadonly } from "../../components/provider-accounts-readonly.tsx";
import { hostId, apiGet } from "../../lib/api.ts";
import { loadHostInventoryWithVersion } from "../../lib/inventory.ts";
import { can, loadPrincipal } from "../../lib/principal.ts";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const id = hostId();
  const principal = await loadPrincipal();
  const canEditExecConfig = can(principal, "fleet:exec-config");
  const { inventory, version } = await loadHostInventoryWithVersion(id);

  let providers: Provider[] = [];
  let providerAccounts: ProviderAccount[] = [];
  let commands: Command[] = [];
  let catalogError: string | null = null;
  try {
    const [p, a, c] = await Promise.all([
      apiGet<{ items: Provider[] }>("/api/v1/providers"),
      apiGet<{ items: ProviderAccount[] }>("/api/v1/provider-accounts"),
      apiGet<{ items: Command[] }>("/api/v1/commands"),
    ]);
    providers = p.items ?? [];
    providerAccounts = a.items ?? [];
    commands = c.items ?? [];
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error);
  }
  const providersById = Object.fromEntries(providers.map((p) => [p.id, p]));
  const providerAccountsById = Object.fromEntries(providerAccounts.map((a) => [a.id, a]));
  const commandsById = Object.fromEntries(commands.map((c) => [c.id, c]));

  const initialJson = JSON.stringify(
    {
      setupScript: inventory.setupScript,
      allowedRoots: inventory.allowedRoots,
      requiredEnvironment: inventory.requiredEnvironment,
      repositories: inventory.repositories,
      providerAccounts: inventory.providerAccounts,
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
        <DrainButton hostId={id} label="Drain this host" pendingLabel="Draining…" pw="host-drain" />
      </div>

      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Provider accounts</h3>
        <p className="text-sm text-muted-foreground">
          Read-only — attach, detach, and override provider accounts from the control plane's host
          detail page.
        </p>
        <ProviderAccountsReadonly
          inventory={inventory}
          accountsById={providerAccountsById}
          providersById={providersById}
          commandsById={commandsById}
          catalogError={catalogError}
        />
      </div>

      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Host setup script</h3>
        <p className="text-sm text-muted-foreground">
          Optional host-wide setup run before repository and worktree setup scripts.
        </p>
        <HostSetupScriptForm
          hostId={id}
          setupScript={inventory.setupScript}
          allowedRoots={inventory.allowedRoots}
          requiredEnvironment={inventory.requiredEnvironment}
          canWriteExecConfig={canEditExecConfig}
        />
      </div>

      <div className="space-y-2 border-t border-border pt-6">
        <h3 className="text-lg font-medium">Advanced: raw host inventory JSON</h3>
        <p className="text-sm text-muted-foreground">
          Bulk-edit the full inventory. Prefer the structured controls when possible.
        </p>
        <HostConfigForm hostId={id} initialJson={initialJson} initialVersion={version} />
      </div>
    </div>
  );
}
