import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { enqueueSlackSessionLifecycle } from "./slack-session-runtime.ts";

/** A terminal row must be durable before its concurrency id becomes reusable. */
export function persistTerminalSessionThenReleaseConcurrencyLock(
  state: ControlPlaneState,
  session: SessionRecord,
  concurrencyId: string,
  storage: NonNullable<ControlPlaneState["storage"]>,
): void {
  const stored = { ...session };
  state.sessions.set(session.id, stored);
  queueWrite(state, () =>
    storage
      .putSession(stored)
      .then(() => storage.releaseConcurrencyLock(concurrencyId, session.id))
      .then(() => enqueueSlackSessionLifecycle(state, stored)),
  );
}
