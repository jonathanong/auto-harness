import type { ControlPlaneState } from "./control-plane-state.ts";
import { enqueueHostOfflineAlert } from "./slack-host-alert.ts";
import { offlineHostAndRequeue, offlineHostAndRequeueDurable } from "./control-plane-worktrees.ts";

export { cancelSession } from "./control-plane-cancel-local.ts";
export { planSessionTransition, transitionEffect } from "./session-transition-planner.ts";

export {
  archiveSessionLogs,
  getArchive,
  listArchives,
  queueSessionArchive,
  retrySessionArchiveIfNeeded,
  retryPendingArchives,
} from "./control-plane-archive.ts";

type OfflineAlertCandidate = {
  hostId: string;
  reason: string;
  lastHeartbeatAt: string;
};

type OfflineAlertCandidateStore = {
  recordHostOfflineAlertCandidate(candidate: OfflineAlertCandidate): Promise<boolean>;
  clearHostOfflineAlertCandidate(candidate: OfflineAlertCandidate): Promise<boolean>;
  listHostOfflineAlertCandidates(): Promise<OfflineAlertCandidate[]>;
};

function offlineAlertCandidateStore(
  state: ControlPlaneState,
): OfflineAlertCandidateStore | undefined {
  const storage = state.storage as unknown as Partial<OfflineAlertCandidateStore> | undefined;
  if (
    typeof storage?.recordHostOfflineAlertCandidate !== "function" ||
    typeof storage.clearHostOfflineAlertCandidate !== "function" ||
    typeof storage.listHostOfflineAlertCandidates !== "function"
  ) {
    return undefined;
  }
  return storage as OfflineAlertCandidateStore;
}

function clearLocalOfflineCandidate(
  state: ControlPlaneState,
  candidate: OfflineAlertCandidate,
): void {
  if (
    state.disconnectedHosts.get(candidate.hostId)?.lastHeartbeatAt === candidate.lastHeartbeatAt
  ) {
    state.disconnectedHosts.delete(candidate.hostId);
  }
}

async function enqueueOfflineAlertCandidate(
  state: ControlPlaneState,
  candidate: OfflineAlertCandidate,
  store: OfflineAlertCandidateStore | undefined,
): Promise<boolean> {
  try {
    await enqueueHostOfflineAlert(state, candidate);
    if (store && !(await store.clearHostOfflineAlertCandidate(candidate))) {
      // A fresh registration (or a newer disconnect) may have already
      // replaced this candidate. Its durable record is authoritative, so do
      // not retain this matching stale observation in a warm Lambda.
      clearLocalOfflineCandidate(state, candidate);
      return false;
    }
    clearLocalOfflineCandidate(state, candidate);
    return true;
  } catch {
    return false;
  }
}

async function persistOfflineAlertCandidate(
  store: OfflineAlertCandidateStore | undefined,
  candidate: OfflineAlertCandidate,
): Promise<boolean> {
  if (!store) return true;
  try {
    return await store.recordHostOfflineAlertCandidate(candidate);
  } catch {
    return false;
  }
}

/**
 * Heartbeat-based stale reclaim (Phase 3): free worktrees of agents whose
 * heartbeat is older than heartbeatStaleMs — faster than full session timeout.
 * Also reclaims agents recorded in disconnectedHosts after disconnect/crash.
 * Marks ALL of the agent's worktrees offline (idle + busy) so assigns cannot
 * bind to a zombie agent.
 */
export function reclaimStaleHosts(state: ControlPlaneState, nowMs: number = Date.now()): string[] {
  const reclaimed: string[] = [];
  const candidates = new Map<string, { lastHeartbeatAt: string; connectionId?: string }>();

  for (const [hostId, connectionId] of state.hostConnection.entries()) {
    const conn = state.connections.get(connectionId);
    if (!conn) {
      state.hostConnection.delete(hostId);
      continue;
    }
    candidates.set(hostId, {
      lastHeartbeatAt: conn.lastHeartbeatAt,
      connectionId,
    });
  }
  for (const [hostId, rec] of state.disconnectedHosts.entries()) {
    if (!candidates.has(hostId)) {
      candidates.set(hostId, { lastHeartbeatAt: rec.lastHeartbeatAt });
    }
  }

  for (const [hostId, meta] of candidates) {
    const last = Date.parse(meta.lastHeartbeatAt);
    if (nowMs - last < state.heartbeatStaleMs) {
      continue;
    }
    const reason = "agent heartbeat stale; requeued";
    const freed = offlineHostAndRequeue(state, hostId, reason);
    for (const sid of freed) {
      if (!reclaimed.includes(sid)) {
        reclaimed.push(sid);
      }
    }
    if (meta.connectionId) {
      state.connections.delete(meta.connectionId);
    }
    state.hostConnection.delete(hostId);
    state.disconnectedHosts.delete(hostId);
    void enqueueHostOfflineAlert(state, {
      hostId,
      reason,
      lastHeartbeatAt: meta.lastHeartbeatAt,
    });
  }
  return reclaimed;
}

/** Durable stale recovery. Each host lease is released conditionally and each
 * running session is requeued with a transaction, so two API processes can
 * safely run the sweeper at the same time. */
export async function reclaimStaleHostsDurable(
  state: ControlPlaneState,
  nowMs: number = Date.now(),
): Promise<string[]> {
  if (!state.storage) {
    return reclaimStaleHosts(state, nowMs);
  }
  const alertStore = offlineAlertCandidateStore(state);
  // This Lambda may have no warm-memory connection to the one that released
  // the host lease. Deliver these durable candidates before considering the
  // current process's stale-connection cache.
  if (alertStore) {
    for (const candidate of await alertStore.listHostOfflineAlertCandidates()) {
      await enqueueOfflineAlertCandidate(state, candidate, alertStore);
    }
  }
  const reclaimed: string[] = [];
  const candidates = new Map<string, { lastHeartbeatAt: string; connectionId?: string }>();
  for (const [hostId, connectionId] of state.hostConnection.entries()) {
    const conn = state.connections.get(connectionId);
    if (conn) {
      candidates.set(hostId, { lastHeartbeatAt: conn.lastHeartbeatAt, connectionId });
    }
  }
  for (const [hostId, rec] of state.disconnectedHosts.entries()) {
    if (!candidates.has(hostId)) {
      candidates.set(hostId, { lastHeartbeatAt: rec.lastHeartbeatAt });
    }
  }
  for (const [hostId, meta] of candidates) {
    if (nowMs - Date.parse(meta.lastHeartbeatAt) < state.heartbeatStaleMs) {
      continue;
    }
    const reason = "agent heartbeat stale; requeued";
    if (!meta.connectionId) {
      const candidate = { hostId, reason, lastHeartbeatAt: meta.lastHeartbeatAt };
      if (await persistOfflineAlertCandidate(alertStore, candidate)) {
        await enqueueOfflineAlertCandidate(state, candidate, alertStore);
      }
      continue;
    }
    const freed = await offlineHostAndRequeueDurable(state, hostId, meta.connectionId, reason);
    for (const sid of freed) {
      if (!reclaimed.includes(sid)) reclaimed.push(sid);
    }
    const candidate = { hostId, reason, lastHeartbeatAt: meta.lastHeartbeatAt };
    const released = await state.storage.releaseHostConnection(hostId, meta.connectionId, {
      reason: candidate.reason,
      lastHeartbeatAt: candidate.lastHeartbeatAt,
    });
    if (!released) {
      state.connections.delete(meta.connectionId);
      if (state.hostConnection.get(hostId) === meta.connectionId) {
        state.hostConnection.delete(hostId);
      }
      continue;
    }
    state.connections.delete(meta.connectionId);
    state.hostConnection.delete(hostId);
    state.disconnectedHosts.set(hostId, { lastHeartbeatAt: meta.lastHeartbeatAt });
    // The candidate was written in the exact lease-release transaction, so a
    // failed Slack lookup/enqueue remains visible to a cold cron Lambda.
    await enqueueOfflineAlertCandidate(state, candidate, alertStore);
  }
  return reclaimed;
}
