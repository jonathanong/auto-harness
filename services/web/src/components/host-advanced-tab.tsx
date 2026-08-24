import type { HostUpdateConfig } from "@auto-harness/shared";
import { HostConfigForm, HostSetupScriptForm, HostUpdateConfigForm } from "@auto-harness/ui";

export function HostAdvancedTab({
  hostId,
  initialJson,
  initialVersion,
  setupScript,
  allowedRoots,
  requiredEnvironment,
  updateConfig,
  canWriteInventory = true,
  canWriteExecConfig = false,
}: Readonly<{
  hostId: string;
  initialJson: string;
  initialVersion: number;
  setupScript: string | undefined;
  allowedRoots: string[] | undefined;
  requiredEnvironment: string[] | undefined;
  updateConfig?: HostUpdateConfig | undefined;
  canWriteInventory?: boolean;
  canWriteExecConfig?: boolean;
}>) {
  const canWrite = canWriteInventory || canWriteExecConfig;
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Configure host-wide setup scripts and allowed roots here. The raw editor remains available
        for bulk inventory changes and cannot change executable paths without admin exec-config
        access.
      </p>
      {canWrite ? (
        <>
          <HostSetupScriptForm
            hostId={hostId}
            setupScript={setupScript}
            allowedRoots={allowedRoots}
            requiredEnvironment={requiredEnvironment}
            canWriteExecConfig={canWriteExecConfig}
            canWriteInventory={canWriteInventory}
          />
          <HostUpdateConfigForm
            hostId={hostId}
            updateConfig={updateConfig}
            canWriteExecConfig={canWriteExecConfig}
          />
          {canWriteInventory ? (
            <section className="space-y-2 border-t border-border pt-6">
              <h3 className="text-lg font-medium">Raw host inventory JSON</h3>
              <p className="text-sm text-muted-foreground">
                Power-user full-document editor for bulk inventory changes. Setup scripts and
                executable paths require <code>fleet:exec-config</code>.
              </p>
              <HostConfigForm
                hostId={hostId}
                initialJson={initialJson}
                initialVersion={initialVersion}
              />
            </section>
          ) : null}
        </>
      ) : (
        <pre className="overflow-auto rounded-md border border-border p-3 font-mono text-xs">
          {initialJson}
        </pre>
      )}
    </div>
  );
}
