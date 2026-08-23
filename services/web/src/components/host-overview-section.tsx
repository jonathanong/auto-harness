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
  environmentReadiness?: Record<string, { required: string[]; missing: string[]; ready: boolean }>;
};

export function HostOverviewSection({
  hostId,
  agent,
  agentsError,
  repoCount,
  worktreeCount,
  repositoryNames,
}: {
  hostId: string;
  agent: Agent | undefined;
  agentsError: string | null;
  repoCount: number;
  worktreeCount: number;
  repositoryNames: Record<string, string>;
}) {
  const readiness = Object.entries(agent?.environmentReadiness ?? {}).filter(
    ([, value]) => value.required.length > 0,
  );
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
      {readiness.length > 0 ? (
        <section className="space-y-2" data-pw="host-environment-readiness">
          <h3 className="text-sm font-medium">Repository environment readiness</h3>
          <ul className="space-y-1 text-sm">
            {readiness.map(([repositoryId, value]) => (
              <li key={repositoryId} data-pw={`host-environment-readiness-${repositoryId}`}>
                <span className="font-medium">
                  {repositoryNames[repositoryId] ?? repositoryId}:
                </span>{" "}
                {value.ready ? "Ready" : `Missing ${value.missing.join(", ")}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {agent?.online ? null : <ConnectHostPanel hostId={hostId} />}
    </div>
  );
}
