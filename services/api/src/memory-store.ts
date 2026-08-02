import { randomBytes } from "node:crypto";

import { validateCreateSessionInput, type SessionStatus } from "@auto-harness/shared";

export type StoredSession = {
  id: string;
  repositoryId: string;
  prompt: string;
  commandProfile: string;
  timeout: number;
  priority: number;
  requiredLabels: string[];
  onConflict: "queue" | "replace" | "reject";
  status: SessionStatus;
  ref?: string;
  worktreeId?: string | null;
  createdAt: string;
  url: string;
};

type MemoryStoreOptions = {
  publicBaseUrl?: string;
  now?: () => string;
  idFactory?: () => string;
};

export class MemorySessionStore {
  private readonly sessions = new Map<string, StoredSession>();
  private readonly publicBaseUrl: string;
  private readonly now: () => string;
  private readonly idFactory: () => string;

  constructor(options: MemoryStoreOptions = {}) {
    this.publicBaseUrl = options.publicBaseUrl ?? "http://localhost:3000";
    this.now = options.now ?? (() => new Date().toISOString());
    this.idFactory = options.idFactory ?? (() => `sess-${randomBytes(4).toString("hex")}`);
  }

  create(body: unknown): { ok: true; session: StoredSession } | { ok: false; error: string } {
    if (typeof body !== "object" || body === null) {
      return { ok: false, error: "body must be an object" };
    }
    const record = body as Record<string, unknown>;
    const validated = validateCreateSessionInput({
      repositoryId: record.repositoryId,
      prompt: record.prompt,
      commandProfile: record.commandProfile,
      timeout: record.timeout,
      priority: record.priority,
      requiredLabels: record.requiredLabels,
      onConflict: record.onConflict,
      ref: record.ref,
    });
    if (!validated.ok) {
      return validated;
    }
    const id = this.idFactory();
    const session: StoredSession = {
      id,
      repositoryId: validated.value.repositoryId,
      prompt: validated.value.prompt,
      commandProfile: validated.value.commandProfile,
      timeout: validated.value.timeout,
      priority: validated.value.priority,
      requiredLabels: validated.value.requiredLabels,
      onConflict: validated.value.onConflict,
      status: "queued",
      createdAt: this.now(),
      url: `${this.publicBaseUrl}/sessions/${id}`,
      ...(validated.value.ref !== undefined ? { ref: validated.value.ref } : {}),
    };
    this.sessions.set(id, session);
    return { ok: true, session };
  }

  get(id: string): StoredSession | undefined {
    return this.sessions.get(id);
  }

  list(): StoredSession[] {
    return [...this.sessions.values()].toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  setStatus(id: string, status: SessionStatus): StoredSession | undefined {
    const session = this.sessions.get(id);
    if (!session) {
      return undefined;
    }
    session.status = status;
    return session;
  }
}
