import { ConnectHostPanel } from "./connect-host-panel.tsx";
import { HostOverviewTab } from "./host-overview-tab.tsx";

type Agent = {
  online: boolean;
  connectedAt?: string | null;
  daemonStartedAt?: string | null;
  restartCount?: number;
  lastRestartDetectedAt?: string | null;
  daemonVersion?: string | null;
  gitVersion?: string | null;
  gitReady?: boolean;
  gitReadinessReason?: string | null;
};

export function HostOverviewSection({
  hostId,
  agent,
  agentsError,
  repoCount,
  worktreeCount,
}: {
  hostId: string;
  agent: Agent | undefined;
  agentsError: string | null;
  repoCount: number;
  worktreeCount: number;
}) {
  return (
    <div className="space-y-4">
      <HostOverviewTab
        hostId={hostId}
        online={agent?.online ?? false}
        agentsError={agentsError}
        repoCount={repoCount}
        worktreeCount={worktreeCount}
        connectedAt={agent?.connectedAt}
        daemonStartedAt={agent?.daemonStartedAt}
        restartCount={agent?.restartCount}
        lastRestartDetectedAt={agent?.lastRestartDetectedAt}
        daemonVersion={agent?.daemonVersion}
        gitVersion={agent?.gitVersion}
        gitReady={agent?.gitReady}
        gitReadinessReason={agent?.gitReadinessReason}
      />
      {agent?.online ? null : <ConnectHostPanel hostId={hostId} />}
    </div>
  );
}
