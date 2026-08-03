import { ControlPlane, type PublicSession } from "./control-plane.ts";

export type StoredSession = PublicSession;

type MemoryStoreOptions = {
  publicBaseUrl?: string;
  now?: () => string;
  idFactory?: () => string;
  plane?: ControlPlane;
};

/**
 * Thin session facade over {@link ControlPlane}.
 * Prefer `createControlPlane()` so the plane is backed by DynamoDB Local
 * (amazon/dynamodb-local), not a custom database.
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
    return this.plane.forceStatus(id, status) ?? undefined;
  }
}
