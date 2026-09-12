import { TERMINAL_HOOK_HANDOFF_PROTOCOL_VERSION, type HostWireMessage } from "@auto-harness/shared";

import { queueSessionArchive } from "./control-plane-archive.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";

export const TERMINAL_HOOK_HANDOFF_DELIVERY_LIMIT = 500;

/** Release a target reservation only after its exact handoff is terminally disposed. */
function releaseReservedWorktree(
  state: ControlPlaneState,
  sessionId: string,
  worktreeId: string | null,
): void {
  if (!worktreeId) return;
  const worktree = state.worktrees.get(worktreeId);
  if (!worktree || worktree.currentSessionId !== sessionId) return;
  if (!state.storage) {
    releaseWorktree(state, worktreeId);
    return;
  }
  // The durable settle/expiry transaction has already released the row. Keep
  // this process cache coherent without issuing a second, unfenced write.
  state.worktrees.set(worktreeId, { ...worktree, status: "idle", currentSessionId: null });
}

/**
 * Handoffs are indexed with the original host's active-claim key. This keeps
 * replacement registration bounded: no session-table scan is needed to find
 * a crashed daemon's still-unsettled repository hook.
 */
export async function pendingTerminalHookHandoffs(
  state: ControlPlaneState,
  hostId: string,
  options: {
    connectionId?: string;
    protocolVersion?: number;
    sessionIds?: readonly string[];
  } = {},
): Promise<Array<Extract<HostWireMessage, { type: "session:terminal-hook" }>>> {
  const connectionId = options.connectionId ?? state.hostConnection.get(hostId);
  if (
    (options.protocolVersion ??
      (connectionId === undefined
        ? 0
        : (state.connections.get(connectionId)?.protocolVersion ?? 0))) <
    TERMINAL_HOOK_HANDOFF_PROTOCOL_VERSION
  ) {
    return [];
  }
  const sessions =
    options.sessionIds && state.storage
      ? (
          await Promise.all(
            options.sessionIds.map((sessionId) => state.storage!.getSession(sessionId, true)),
          )
        ).filter((session): session is NonNullable<typeof session> => session !== null)
      : state.storage
        ? await state.storage.listActiveSessionsByHost(hostId)
        : [...state.sessions.values()].filter((session) => session.activeHostId === hostId);
  const pending: Array<Extract<HostWireMessage, { type: "session:terminal-hook" }>> = [];
  const sessionIds = options.sessionIds ? new Set(options.sessionIds) : undefined;
  const nowMs = Date.parse(state.now());
  for (const session of sessions) {
    if (sessionIds && !sessionIds.has(session.id)) continue;
    const handoff = session.terminalHookHandoff;
    if (!handoff || handoff.hostId !== hostId) continue;
    if (Date.parse(handoff.expiresAt) <= nowMs) {
      await expireTerminalHookHandoffIfNeeded(state, session, nowMs);
      continue;
    }
    pending.push({
      type: "session:terminal-hook",
      handoffId: handoff.handoffId,
      sessionId: session.id,
      repositoryId: handoff.repositoryId,
      worktreeId: handoff.worktreeId,
      status: handoff.status,
      ...(handoff.errorCode !== undefined ? { errorCode: handoff.errorCode } : {}),
      ...(handoff.ref !== undefined ? { ref: handoff.ref } : {}),
      ...(handoff.metadata !== undefined ? { metadata: handoff.metadata } : {}),
    });
    if (pending.length >= TERMINAL_HOOK_HANDOFF_DELIVERY_LIMIT) break;
  }
  return pending;
}

/** Clear a handoff only after the same host's current connection confirms it. */
export async function settleTerminalHookHandoff(
  state: ControlPlaneState,
  input: {
    sessionId: string;
    handoffId: string;
    hostId: string;
    connectionId?: string;
    result?: import("@auto-harness/shared").SessionResult;
  },
): Promise<boolean> {
  const cached = state.sessions.get(input.sessionId);
  const session = state.storage ? await state.storage.getSession(input.sessionId, true) : cached;
  const handoff = session?.terminalHookHandoff;
  if (
    !session ||
    !handoff ||
    handoff.handoffId !== input.handoffId ||
    handoff.hostId !== input.hostId
  ) {
    // A lost acknowledgement is idempotent only for this exact handoff and host.
    return (
      session?.terminalHookHandoffSettled?.handoffId === input.handoffId &&
      session.terminalHookHandoffSettled.hostId === input.hostId
    );
  }
  const settled = state.storage
    ? input.connectionId !== undefined &&
      (await state.storage.settleTerminalHookHandoff({
        sessionId: input.sessionId,
        handoffId: input.handoffId,
        hostId: input.hostId,
        connectionId: input.connectionId,
        worktreeId: handoff.worktreeId,
        ...(input.result ? { result: input.result } : {}),
      }))
    : input.connectionId !== undefined &&
      state.hostConnection.get(input.hostId) === input.connectionId;
  if (!settled) return false;
  releaseReservedWorktree(state, session.id, handoff.worktreeId);
  const next = { ...session, ...(input.result ? { result: input.result } : {}) };
  delete next.terminalHookHandoff;
  delete next.activeHostId;
  delete next.activeHostOrder;
  next.terminalHookHandoffSettled = { handoffId: input.handoffId, hostId: input.hostId };
  state.sessions.set(next.id, next);
  queueSessionArchive(state, next.id);
  return true;
}

/** Scheduler recovery visits every session row already; use that bounded sweep to release a lost host's hook. */
export async function expireTerminalHookHandoffIfNeeded(
  state: ControlPlaneState,
  session: import("./db/types.ts").SessionRecord,
  nowMs: number,
): Promise<boolean> {
  const handoff = session.terminalHookHandoff;
  if (!handoff || Date.parse(handoff.expiresAt) > nowMs) return false;
  const expired = state.storage
    ? await state.storage.expireTerminalHookHandoff({
        sessionId: session.id,
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
        worktreeId: handoff.worktreeId,
      })
    : true;
  if (!expired) return false;
  releaseReservedWorktree(state, session.id, handoff.worktreeId);
  const next = { ...session, terminalHookHandoffExpiredAt: handoff.expiresAt };
  delete next.terminalHookHandoff;
  delete next.activeHostId;
  delete next.activeHostOrder;
  state.sessions.set(next.id, next);
  queueSessionArchive(state, next.id);
  return true;
}
