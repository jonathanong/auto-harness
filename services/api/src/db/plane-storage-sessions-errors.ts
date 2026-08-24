import { getSessionDrain } from "./plane-storage-session-drains.ts";
import { sessionPrincipalId } from "../control-plane-session-owner.ts";
import type { SessionRecord } from "./types.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

export type CreateSessionResult =
  | { created: true; session: SessionRecord }
  | { created: false; session: SessionRecord };

export class SessionIdCollisionError extends Error {
  constructor(sessionId: string) {
    super(`session id collision: ${sessionId}`);
    this.name = "SessionIdCollisionError";
  }
}

export class CreateSessionRetryExhaustedError extends Error {
  constructor(concurrencyId: string) {
    super(`could not resolve concurrency lock for ${concurrencyId}`);
    this.name = "CreateSessionRetryExhaustedError";
  }
}

export class CatalogDeletionInProgressError extends Error {
  constructor() {
    super("catalog deletion is in progress");
    this.name = "CatalogDeletionInProgressError";
  }
}

export class RepositoryAdmissionClosedError extends Error {
  constructor() {
    super("repository admission is closed");
    this.name = "RepositoryAdmissionClosedError";
  }
}

class SessionDrainActiveError extends Error {
  readonly operationId: string;

  constructor(operationId: string) {
    super("principal session admission is draining");
    this.name = "SessionDrainActiveError";
    this.operationId = operationId;
  }
}

export function isRepositoryAdmissionClosed(err: unknown): boolean {
  return err instanceof Error && err.name === "RepositoryAdmissionClosedError";
}

export function sessionDrainOperationId(err: unknown): string | null {
  return err instanceof SessionDrainActiveError ? err.operationId : null;
}

export async function activeSessionDrainError(
  ctx: PlaneStorageCtx,
  session: SessionRecord,
): Promise<SessionDrainActiveError> {
  const principalId = sessionPrincipalId(session);
  const drain = principalId ? await getSessionDrain(ctx, session.repositoryId, principalId) : null;
  return new SessionDrainActiveError(drain?.operationId ?? "unknown");
}

export function isCreateSessionConflict(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return [
    "SessionIdCollisionError",
    "CreateSessionRetryExhaustedError",
    "CatalogDeletionInProgressError",
  ].includes(err.name);
}
