import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import { prepareResumedSession, type ResumeOptions } from "./control-plane-session-resume.ts";
import { createSession, resumeSession } from "./control-plane-sessions.ts";
import { isCreateSessionConflict } from "./db/plane-storage-sessions.ts";
import { getSessionDurable } from "./control-plane-durable-read-runtime.ts";
import { refreshTargetCatalogDurable } from "./control-plane-durable-read-catalog.ts";

/** Durable REST create path: DynamoDB owns the concurrency-id compare-and-create. */
export async function createSessionDurable(
  state: ControlPlaneState,
  body: unknown,
): Promise<
  | { ok: true; session: PublicSession; created: boolean }
  | { ok: false; error: string; code?: string }
> {
  if (!state.storage) return createSession(state, body);
  await refreshTargetCatalogDurable(state);
  const prepared = validateSessionCreate(state, body);
  if (!prepared.ok) return prepared;
  let result;
  try {
    result = await state.storage.createSession(buildSessionRecord(state, prepared));
  } catch (err) {
    if (isCreateSessionConflict(err)) {
      return {
        ok: false,
        error: "session creation conflicted; retry the request",
        code: "CONFLICT",
      };
    }
    throw err;
  }
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
  await getSessionDurable(state, sessionId);
  const prepared = prepareResumedSession(state, sessionId, opts);
  if (!prepared.ok) return prepared;
  // Durable preparation deliberately skips process-local deduplication; the
  // storage transaction below is the only concurrency authority.
  let result;
  try {
    result = await state.storage.createSession(prepared.session);
  } catch (err) {
    if (isCreateSessionConflict(err)) {
      return { ok: false, error: "session creation conflicted; retry the request" };
    }
    throw err;
  }
  state.sessions.set(result.session.id, { ...result.session });
  return { ok: true, session: toPublic(state, result.session), created: result.created };
}
