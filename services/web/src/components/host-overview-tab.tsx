import { OnlineStatusBadge, RelativeTime, SectionError } from "@auto-harness/ui";

import { HostRestartDetails } from "./host-restart-details.tsx";

export function HostOverviewTab({
  hostId,
  online,
  agentsError,
  repoCount,
  worktreeCount,
  connectedAt,
  daemonStartedAt,
  restartCount,
  lastRestartDetectedAt,
}: {
  hostId: string;
  online: boolean;
  agentsError: string | null;
  repoCount: number;
  worktreeCount: number;
  connectedAt?: string | null;
  daemonStartedAt?: string | null;
  restartCount?: number;
  lastRestartDetectedAt?: string | null;
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
      <div>
        <dt className="text-xs uppercase text-muted-foreground">Connected</dt>
        <dd className="text-sm" data-pw={`host-connected-at-${hostId}`}>
          <RelativeTime value={connectedAt} label="Connected" />
        </dd>
      </div>
      <div className="sm:col-span-2">
        <dt className="text-xs uppercase text-muted-foreground">Daemon</dt>
        <dd className="text-sm">
          <HostRestartDetails
            hostId={hostId}
            daemonStartedAt={daemonStartedAt}
            restartCount={restartCount}
            lastRestartDetectedAt={lastRestartDetectedAt}
          />
        </dd>
      </div>
    </dl>
  );
}
