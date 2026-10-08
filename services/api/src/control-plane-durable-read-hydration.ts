import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  sessionOccupiesHostAssignment,
  sessionOccupiesProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";

export async function hydrateRunningSessions(
  state: ControlPlaneState,
  storage: DynamoPlaneStorage,
): Promise<boolean> {
  if (typeof storage.listOperationalSessions !== "function") return false;
  const candidates = await storage.listOperationalSessions(state.shardCount);
  const occupying = new Map(
    candidates
      .filter(
        (session) =>
          session.status === "running" ||
          sessionOccupiesHostAssignment(session) ||
          sessionOccupiesProviderAccountLease(session),
      )
      .map((session) => [session.id, session]),
  );
  const localHolders = [...state.sessions.values()].filter(
    (session) =>
      sessionOccupiesHostAssignment(session) || sessionOccupiesProviderAccountLease(session),
  );
  const extras: SessionRecord[] = [];
  for (const session of localHolders) {
    if (occupying.has(session.id)) continue;
    const fresh =
      typeof storage.getSession === "function"
        ? await storage.getSession(session.id, true)
        : session;
    if (
      fresh &&
      (sessionOccupiesHostAssignment(fresh) || sessionOccupiesProviderAccountLease(fresh))
    ) {
      extras.push(fresh);
    }
  }
  for (const [id, session] of state.sessions) {
    if (
      session.status === "running" ||
      session.status === "cancelled" ||
      sessionOccupiesProviderAccountLease(session)
    ) {
      state.sessions.delete(id);
    }
  }
  for (const session of occupying.values()) state.sessions.set(session.id, { ...session });
  for (const session of extras) state.sessions.set(session.id, { ...session });
  return true;
}
