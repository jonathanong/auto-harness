import { ControlPlane, type PublicSession } from "./control-plane.js";

export type StoredSession = PublicSession;

type MemoryStoreOptions = {
  publicBaseUrl?: string;
  now?: () => string;
  idFactory?: () => string;
  plane?: ControlPlane;
};

/**
 * Thin facade used by Phase 1 local server paths.
 * Backed by {@link ControlPlane} for full Phase 2–5 behavior.
 */
export class MemorySessionStore {
  readonly plane: ControlPlane;

  constructor(options: MemoryStoreOptions = {}) {
    this.plane =
      options.plane ??
      new ControlPlane({
        ...(options.publicBaseUrl !== undefined ? { publicBaseUrl: options.publicBaseUrl } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
        ...(options.idFactory !== undefined ? { idFactory: options.idFactory } : {}),
      });
  }

  create(body: unknown): { ok: true; session: StoredSession } | { ok: false; error: string } {
    const result = this.plane.createSession(body);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, session: result.session };
  }

  get(id: string): StoredSession | undefined {
    return this.plane.getSession(id) || undefined;
  }

  list(): StoredSession[] {
    return this.plane.listSessions();
  }

  setStatus(id: string, status: StoredSession["status"]): StoredSession | undefined {
    if (!this.plane.getSession(id)) {
      return undefined;
    }
    this.plane.handleAgentMessage({
      type: "session:status",
      sessionId: id,
      status,
    });
    return this.get(id);
  }
}
