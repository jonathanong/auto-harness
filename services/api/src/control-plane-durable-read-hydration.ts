import type { DynamoPlaneStorage } from "./db/plane-storage.ts";
import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { sessionOccupiesHostAssignment } from "./control-plane-provider-account-leases.ts";

async function listSessionsByStatusAcrossShards(
  state: ControlPlaneState,
  storage: DynamoPlaneStorage,
  status: SessionRecord["status"],
): Promise<SessionRecord[]> {
  return (
    await Promise.all(
      [...Array(state.shardCount).keys()].map((shard) =>
        storage.listSessionsByStatus(status, shard),
      ),
    )
  ).flat();
}

export async function hydrateRunningSessions(
  state: ControlPlaneState,
  storage: DynamoPlaneStorage,
): Promise<void> {
  if (typeof storage.listSessionsByStatus !== "function") return;
  const [running, cancelled] = await Promise.all([
    listSessionsByStatusAcrossShards(state, storage, "running"),
    listSessionsByStatusAcrossShards(state, storage, "cancelled"),
  ]);
  const occupying = new Map(
    [...running, ...cancelled.filter(sessionOccupiesHostAssignment)].map((session) => [
      session.id,
      session,
    ]),
  );
  const localHolders = [...state.sessions.values()].filter(sessionOccupiesHostAssignment);
  const extras: SessionRecord[] = [];
  for (const session of localHolders) {
    if (occupying.has(session.id)) continue;
    const fresh =
      typeof storage.getSession === "function"
        ? await storage.getSession(session.id, true)
        : session;
    if (fresh && sessionOccupiesHostAssignment(fresh)) extras.push(fresh);
  }
  for (const [id, session] of state.sessions) {
    if (session.status === "running" || session.status === "cancelled") state.sessions.delete(id);
  }
  for (const session of occupying.values()) state.sessions.set(session.id, { ...session });
  for (const session of extras) state.sessions.set(session.id, { ...session });
}
