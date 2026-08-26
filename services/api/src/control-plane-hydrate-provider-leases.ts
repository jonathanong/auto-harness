import type { DynamoPlaneStorage, ProviderAccountRecord } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";
import { providerAccountLeaseConcurrencyId } from "@auto-harness/shared";
import { maxConcurrentSessionsFor } from "./control-plane-provider-account-leases.ts";

type HydrateLeaseState = {
  storage: DynamoPlaneStorage | undefined;
  providerAccounts: Map<string, ProviderAccountRecord>;
};

/** Backfill legacy provider assignments before exposing the hydrated scheduler snapshot. */
export async function backfillLegacyProviderAccountLeases(
  state: HydrateLeaseState,
  sessions: SessionRecord[],
): Promise<void> {
  const storage = state.storage;
  if (!storage || typeof storage.backfillProviderAccountLease !== "function") return;
  const occupied = new Set<string>();
  for (const session of sessions) {
    if (
      (session.status === "running" ||
        (session.status === "cancelled" && session.hostId != null)) &&
      session.providerAccountLease
    ) {
      occupied.add(session.providerAccountLease.concurrencyId);
    }
  }
  // A released cancelled session has nothing to migrate (release clears worktreeId/mainCheckoutLease);
  // backfilling it resurrects a dead attempt no host will ack. A cancelled session still holding either
  // is legitimately mid-release and still occupies the account, so it stays a candidate.
  const candidates = sessions
    .filter(
      (session) =>
        (session.status === "running" ||
          (session.status === "cancelled" &&
            (session.worktreeId != null || session.mainCheckoutLease === true))) &&
        session.hostId != null &&
        session.resolvedRoute?.providerAccountId != null &&
        session.providerAccountLease == null,
    )
    .toSorted((left, right) => left.id.localeCompare(right.id));
  for (const session of candidates) {
    const route = session.resolvedRoute;
    const providerAccountId = route?.providerAccountId;
    const hostId = session.hostId;
    const attemptId = session.attemptId ?? route?.attemptId;
    if (!providerAccountId || !hostId || !attemptId) continue;
    const maxConcurrentSessions = maxConcurrentSessionsFor(
      state.providerAccounts.get(providerAccountId),
    );
    for (let slot = 0; slot < maxConcurrentSessions; slot += 1) {
      const concurrencyId = providerAccountLeaseConcurrencyId(providerAccountId, slot);
      if (occupied.has(concurrencyId)) continue;
      const result = await storage.backfillProviderAccountLease({
        sessionId: session.id,
        attemptId,
        hostId,
        providerAccountId,
        ...(route.providerId ? { providerId: route.providerId } : {}),
        slot,
      });
      if (result.status === "migrated") {
        session.providerAccountLease = result.lease;
        occupied.add(result.lease.concurrencyId);
        break;
      }
      if (result.status === "session_changed") {
        const latest =
          typeof storage.getSession === "function"
            ? await storage.getSession(session.id, true)
            : null;
        if (latest?.providerAccountLease)
          session.providerAccountLease = latest.providerAccountLease;
        break;
      }
      occupied.add(concurrencyId);
    }
  }
}
