import Link from "next/link";
import { SectionError } from "@auto-harness/ui";

export function HostNotFound({ hostId, message }: { hostId: string; message: string | null }) {
  return (
    <div className="space-y-4" data-pw="page-host-detail-not-found">
      <Link href="/hosts" className="text-sm text-muted-foreground hover:underline">
        ← Back to hosts
      </Link>
      {message ? (
        <SectionError resource={`host ${hostId}`} message={message} selector="host-detail-lookup" />
      ) : (
        <p className="text-sm text-muted-foreground">
          No host <code className="font-mono">{hostId}</code> known to the control plane.
        </p>
      )}
    </div>
  );
}
