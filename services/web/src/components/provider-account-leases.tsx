"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ConfirmButton, RelativeTime, SessionStatusBadge, showToast } from "@auto-harness/ui";
import {
  apiBase,
  apiErrorMessage,
  type ProviderAccountLeaseReleaseResult,
  type ProviderAccountLeaseState,
} from "@auto-harness/shared";

type ProviderAccountLeaseHolder = NonNullable<ProviderAccountLeaseState["holder"]>;

function releaseBlockCopy(holder: ProviderAccountLeaseHolder): string | undefined {
  if (holder.releaseBlock === "session_not_terminal") {
    return "Only a lease held by a terminal Session can be released.";
  }
  if (holder.releaseBlock === "session_not_found") {
    return "The holder Session could not be found; this lease cannot be released safely.";
  }
  if (holder.releaseBlock === "session_lease_mismatch") {
    return "The holder Session no longer matches this lease; refresh before retrying.";
  }
  return undefined;
}

function releaseSuccessCopy(result: ProviderAccountLeaseReleaseResult): string {
  if (!result.released) return "Provider Account slot was already free.";
  if (result.after.holder) {
    return "Lease released; the slot was immediately claimed by another Session.";
  }
  return "Provider Account lease released.";
}

export function ProviderAccountLeases({
  accountId,
  leases,
}: Readonly<{
  accountId: string;
  leases: ProviderAccountLeaseState[] | null;
}>) {
  const router = useRouter();
  if (leases === null) {
    return (
      <span className="text-xs text-destructive" data-pw={`provider-account-leases-${accountId}`}>
        Could not load held leases.
      </span>
    );
  }
  const heldLeases = leases.filter(
    (lease): lease is ProviderAccountLeaseState & { holder: ProviderAccountLeaseHolder } =>
      lease.holder !== null,
  );
  if (heldLeases.length === 0) {
    return (
      <span
        className="text-xs text-muted-foreground"
        data-pw={`provider-account-leases-${accountId}`}
      >
        No held leases.
      </span>
    );
  }
  return (
    <div className="space-y-2" data-pw={`provider-account-leases-${accountId}`}>
      {heldLeases.map((lease) => {
        const holder = lease.holder;
        const blockedCopy = releaseBlockCopy(holder);
        const ageAt = holder.sessionStartedAt ?? holder.sessionCreatedAt;
        return (
          <div
            className="flex flex-wrap items-center gap-2 text-xs"
            data-pw={`provider-account-lease-${accountId}-${String(lease.slot)}`}
            key={lease.slot}
          >
            <span className="font-mono">slot {lease.slot}</span>
            <Link className="font-mono hover:underline" href={`/sessions/${holder.sessionId}`}>
              {holder.sessionId}
            </Link>
            {holder.sessionStatus ? (
              <SessionStatusBadge status={holder.sessionStatus} />
            ) : (
              <span className="text-destructive">Session missing</span>
            )}
            {holder.hostId ? <span className="text-muted-foreground">{holder.hostId}</span> : null}
            <RelativeTime
              value={ageAt}
              label="Session age"
              pw={`provider-account-lease-age-${accountId}-${String(lease.slot)}`}
            />
            <ConfirmButton
              triggerLabel="Release"
              confirmTitle={`Release slot ${String(lease.slot)}?`}
              confirmDescription={`Force-release the lease held by terminal Session ${holder.sessionId}. A queued Session may claim the slot immediately.`}
              confirmLabel="Release lease"
              disabled={!holder.releasable}
              tip={blockedCopy}
              pw={`provider-account-lease-release-${accountId}-${String(lease.slot)}`}
              onConfirm={async () => {
                const response = await fetch(
                  `${apiBase()}/api/v1/provider-accounts/${encodeURIComponent(accountId)}/leases/${String(lease.slot)}/release`,
                  { method: "POST" },
                );
                if (!response.ok) {
                  return { ok: false, error: await apiErrorMessage(response) };
                }
                const result = (await response.json()) as ProviderAccountLeaseReleaseResult;
                showToast(releaseSuccessCopy(result), {
                  pw: `provider-account-lease-release-success-${accountId}-${String(lease.slot)}`,
                });
                router.refresh();
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
