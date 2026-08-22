import { HostConfigForm, HostSetupScriptForm } from "@auto-harness/ui";

export function HostAdvancedTab({
  hostId,
  initialJson,
  initialVersion,
  setupScript,
  canWrite = true,
}: {
  hostId: string;
  initialJson: string;
  initialVersion: number;
  setupScript: string | undefined;
  canWrite?: boolean;
}) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Configure the host-wide setup script here. The raw editor remains available for bulk
        inventory changes.
      </p>
      {canWrite ? (
        <>
          <HostSetupScriptForm hostId={hostId} setupScript={setupScript} />
          <section className="space-y-2 border-t border-border pt-6">
            <h3 className="text-lg font-medium">Raw host inventory JSON</h3>
            <p className="text-sm text-muted-foreground">
              Power-user full-document editor for bulk changes. Prefer the structured forms when
              possible.
            </p>
            <HostConfigForm
              hostId={hostId}
              initialJson={initialJson}
              initialVersion={initialVersion}
            />
          </section>
        </>
      ) : (
        <pre className="overflow-auto rounded-md border border-border p-3 font-mono text-xs">
          {initialJson}
        </pre>
      )}
    </div>
  );
}
