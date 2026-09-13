import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

function removeIndexedHandoff(state: ControlPlaneState, hostId: string, sessionId: string): void {
  const indexed = state.pendingTerminalHookHandoffsByHost.get(hostId);
  if (!indexed) return;
  indexed.delete(sessionId);
  if (indexed.size === 0) state.pendingTerminalHookHandoffsByHost.delete(hostId);
}

export function indexPendingTerminalHookHandoff(
  state: ControlPlaneState,
  previous: SessionRecord | undefined,
  next: SessionRecord | undefined,
): void {
  const previousHost = previous?.terminalHookHandoff?.hostId;
  const nextHost = next?.terminalHookHandoff?.hostId;
  if (previousHost && previous && (previousHost !== nextHost || !next?.terminalHookHandoff)) {
    removeIndexedHandoff(state, previousHost, previous.id);
  }
  if (nextHost && next?.terminalHookHandoff) {
    const indexed = state.pendingTerminalHookHandoffsByHost.get(nextHost) ?? new Set<string>();
    indexed.add(next.id);
    state.pendingTerminalHookHandoffsByHost.set(nextHost, indexed);
  }
}

export function attachPendingTerminalHookHandoffIndex(state: ControlPlaneState): void {
  const sessions = state.sessions;
  const set = sessions.set.bind(sessions);
  const del = sessions.delete.bind(sessions);
  const clear = sessions.clear.bind(sessions);
  sessions.set = (id: string, session: SessionRecord) => {
    indexPendingTerminalHookHandoff(state, sessions.get(id), session);
    return set(id, session);
  };
  sessions.delete = (id: string) => {
    indexPendingTerminalHookHandoff(state, sessions.get(id), undefined);
    return del(id);
  };
  sessions.clear = () => {
    for (const session of sessions.values()) {
      indexPendingTerminalHookHandoff(state, session, undefined);
    }
    return clear();
  };
}

export function inMemorySessionsForPendingHandoffs(
  state: ControlPlaneState,
  hostId: string,
  sessionIds?: ReadonlySet<string>,
): SessionRecord[] {
  const ids = sessionIds ?? state.pendingTerminalHookHandoffsByHost.get(hostId);
  if (!ids) return [];
  const sessions: SessionRecord[] = [];
  for (const id of ids) {
    const session = state.sessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}
