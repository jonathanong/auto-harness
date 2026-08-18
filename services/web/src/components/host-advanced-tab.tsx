import { HostConfigForm } from "@auto-harness/ui";

export function HostAdvancedTab({
  hostId,
  initialJson,
  initialVersion,
}: {
  hostId: string;
  initialJson: string;
  initialVersion: number;
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Power-user edit of the full inventory (bulk worktrees). Prefer the forms on the Repositories
        &amp; Worktrees tab when possible.
      </p>
      <HostConfigForm hostId={hostId} initialJson={initialJson} initialVersion={initialVersion} />
    </div>
  );
}
