import { RelativeTime } from "@auto-harness/ui";

type HostRestartDetailsProps = {
  hostId: string;
  daemonStartedAt?: string | null;
  restartCount?: number;
  lastRestartDetectedAt?: string | null;
  daemonVersion?: string | null;
  gitVersion?: string | null;
  gitReady?: boolean;
  gitReadinessReason?: string | null;
};

/** Durable local observability only; this component does not trigger or notify a restart. */
export function HostRestartDetails({
  hostId,
  daemonStartedAt,
  restartCount = 0,
  lastRestartDetectedAt,
  daemonVersion,
  gitVersion,
  gitReady = false,
  gitReadinessReason,
}: HostRestartDetailsProps) {
  return (
    <div className="whitespace-nowrap text-xs">
      <div data-pw={`host-restart-count-${hostId}`}>
        {restartCount} restart{restartCount === 1 ? "" : "s"} detected
      </div>
      <div className="text-muted-foreground">
        Started:{" "}
        {daemonStartedAt ? (
          <RelativeTime value={daemonStartedAt} pw={`host-daemon-started-at-${hostId}`} />
        ) : (
          <span data-pw={`host-daemon-started-at-${hostId}`}>legacy/unknown</span>
        )}
      </div>
      {lastRestartDetectedAt ? (
        <div className="text-muted-foreground">
          Last detected:{" "}
          <RelativeTime value={lastRestartDetectedAt} pw={`host-last-restart-${hostId}`} />
        </div>
      ) : null}
      <div className="mt-2" data-pw={`host-daemon-version-${hostId}`}>
        Daemon: {daemonVersion ?? "legacy/unknown"}
      </div>
      <div data-pw={`host-git-version-${hostId}`}>Git: {gitVersion ?? "unknown"}</div>
      <div data-pw={`host-git-readiness-${hostId}`}>
        {gitReady ? "Git checkout recovery ready" : gitReadinessMessage(gitReadinessReason)}
      </div>
    </div>
  );
}

function gitReadinessMessage(reason: string | null | undefined): string {
  switch (reason) {
    case "git_version_unsupported":
      return "Git 2.36 or newer is required for checkout recovery.";
    case "git_unavailable":
      return "Install Git 2.36 or newer and ensure it is on PATH.";
    case "git_version_unparseable":
      return "Install a supported Git 2.36 or newer distribution.";
    default:
      return "Upgrade the host daemon to report Git readiness.";
  }
}
