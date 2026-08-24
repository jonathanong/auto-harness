import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  sessionOccupiesHostAssignment,
  sessionOccupiesProviderAccountLease,
} from "./control-plane-provider-account-leases.ts";

async function listSessionsByStatusAcrossShards(
  state: ControlPlaneState,
  storage: DynamoPlaneStorage,
  status: SessionRecord["status"],
): Promise<SessionRecord[]> {
  const candidates = (
    await Promise.all(
      [...Array(state.shardCount).keys()].map((shard) =>
        storage.listSessionsByStatus(status, shard),
      ),
    )
  ).flat();
  if (typeof storage.getSession !== "function") return candidates;
  const refreshed = await Promise.all(
    candidates.map((candidate) => storage.getSession(candidate.id, true)),
  );
  return refreshed.filter((session): session is SessionRecord => session?.status === status);
}

export async function hydrateRunningSessions(
  state: ControlPlaneState,
  storage: DynamoPlaneStorage,
): Promise<boolean> {
  if (typeof storage.listSessionsByStatus !== "function") return false;
  const [running, cancelled, timedOut] = await Promise.all([
    listSessionsByStatusAcrossShards(state, storage, "running"),
    listSessionsByStatusAcrossShards(state, storage, "cancelled"),
    listSessionsByStatusAcrossShards(state, storage, "timed_out"),
  ]);
  const occupying = new Map(
    [
      ...running,
      ...cancelled.filter(sessionOccupiesHostAssignment),
      ...timedOut.filter(sessionOccupiesProviderAccountLease),
    ].map((session) => [session.id, session]),
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
