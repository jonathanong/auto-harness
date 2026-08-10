import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";

/** A terminal row must be durable before its concurrency id becomes reusable. */
export function persistTerminalSessionThenReleaseConcurrencyLock(
  state: ControlPlaneState,
  session: SessionRecord,
  concurrencyId: string,
  storage: NonNullable<ControlPlaneState["storage"]>,
): void {
  state.sessions.set(session.id, { ...session });
  queueWrite(
    state,
    storage
      .putSession({ ...session })
      .then(() => storage.releaseConcurrencyLock(concurrencyId, session.id)),
  );
}
