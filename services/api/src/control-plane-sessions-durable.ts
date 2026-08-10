import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import {
  prepareResumedSession,
  type ResumeOptions,
} from "./control-plane-session-resume.ts";
import { createSession, resumeSession } from "./control-plane-sessions.ts";

/** Durable REST create path: DynamoDB owns the concurrency-id compare-and-create. */
export async function createSessionDurable(
  state: ControlPlaneState,
  body: unknown,
): Promise<
  | { ok: true; session: PublicSession; created: boolean }
  | { ok: false; error: string; code?: string }
> {
  if (!state.storage) return createSession(state, body);
  const prepared = validateSessionCreate(state, body);
  if (!prepared.ok) return prepared;
  const result = await state.storage.createSession(buildSessionRecord(state, prepared));
  state.sessions.set(result.session.id, { ...result.session });
  return { ok: true, session: toPublic(state, result.session), created: result.created };
}

/** Durable resume uses the same concurrency lock as a fresh create. */
export async function resumeSessionDurable(
  state: ControlPlaneState,
  sessionId: string,
  opts: ResumeOptions = {},
): Promise<{ ok: true; session: PublicSession; created: boolean } | { ok: false; error: string }> {
  if (!state.storage) {
    return resumeSession(state, sessionId, opts);
  }
  const prepared = prepareResumedSession(state, sessionId, opts);
  if (!prepared.ok) return prepared;
  if (!prepared.created) {
    return { ok: true, session: toPublic(state, prepared.session), created: false };
  }
  const result = await state.storage.createSession(prepared.session);
  state.sessions.set(result.session.id, { ...result.session });
  return { ok: true, session: toPublic(state, result.session), created: result.created };
}
