import { HostConfigForm } from "@auto-harness/ui";

export function HostAdvancedTab({
  hostId,
  initialJson,
  initialVersion,
  canWrite = true,
}: {
  hostId: string;
  initialJson: string;
  initialVersion: number;
  canWrite?: boolean;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Power-user edit of the full inventory (bulk worktrees). Prefer the forms on the Repositories
        &amp; Worktrees tab when possible.
      </p>
      {canWrite ? (
        <HostConfigForm hostId={hostId} initialJson={initialJson} initialVersion={initialVersion} />
      ) : (
        <pre className="overflow-auto rounded-md border border-border p-3 font-mono text-xs">
          {initialJson}
        </pre>
      )}
    </div>
  );
}
