import Link from "next/link";
import { DrainButton } from "@auto-harness/ui";

export function HostDetailHeader({ hostId }: { hostId: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <Link
          href="/hosts"
          className="text-sm text-muted-foreground hover:underline"
          data-pw="host-detail-back"
        >
          ← Back to hosts
        </Link>
        <h2 className="text-2xl font-semibold tracking-tight" data-pw="host-detail-id">
          {hostId}
        </h2>
      </div>
      <DrainButton hostId={hostId} pw="host-detail-drain" />
    </div>
  );
}
