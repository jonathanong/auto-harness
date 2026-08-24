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
} from "./control-plane-archive.ts";

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
    if (!meta.connectionId) continue;
    const reason = "agent heartbeat stale; requeued";
    const freed = await offlineHostAndRequeueDurable(state, hostId, meta.connectionId, reason);
    for (const sid of freed) {
      if (!reclaimed.includes(sid)) reclaimed.push(sid);
    }
    const released = await state.storage.releaseHostConnection(hostId, meta.connectionId);
    if (!released) {
      state.connections.delete(meta.connectionId);
      if (state.hostConnection.get(hostId) === meta.connectionId) {
        state.hostConnection.delete(hostId);
      }
      continue;
    }
    state.connections.delete(meta.connectionId);
    state.hostConnection.delete(hostId);
    state.disconnectedHosts.delete(hostId);
    await enqueueHostOfflineAlert(state, {
      hostId,
      reason,
      lastHeartbeatAt: meta.lastHeartbeatAt,
    });
  }
  return reclaimed;
}
