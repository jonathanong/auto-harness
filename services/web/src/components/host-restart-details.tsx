import { RelativeTime } from "@auto-harness/ui";

type HostRestartDetailsProps = {
  hostId: string;
  daemonStartedAt?: string | null;
  restartCount?: number;
  lastRestartDetectedAt?: string | null;
};

/** Durable local observability only; this component does not trigger or notify a restart. */
export function HostRestartDetails({
  hostId,
  daemonStartedAt,
  restartCount = 0,
  lastRestartDetectedAt,
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
    </div>
  );
}
