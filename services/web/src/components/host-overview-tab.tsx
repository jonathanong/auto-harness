import { OnlineStatusBadge, SectionError } from "@auto-harness/ui";

export function HostOverviewTab({
  online,
  agentsError,
  repoCount,
  worktreeCount,
}: {
  online: boolean;
  agentsError: string | null;
  repoCount: number;
  worktreeCount: number;
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-3" data-pw="host-detail-overview">
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Status</dt>
        <dd data-pw="host-detail-status">
          {agentsError ? (
            <SectionError
              resource="host status"
              message={agentsError}
              selector="host-detail-status"
            />
          ) : (
            <OnlineStatusBadge online={online} />
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Repositories</dt>
        <dd className="text-sm" data-pw="host-detail-repo-count">
          {repoCount}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Worktrees</dt>
        <dd className="text-sm" data-pw="host-detail-worktree-count">
          {worktreeCount}
        </dd>
      </div>
    </dl>
  );
}
