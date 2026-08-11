import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { toPublic } from "./control-plane-state.ts";
import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import { prepareResumedSession, type ResumeOptions } from "./control-plane-session-resume.ts";
import {
  prepareClonedSession,
  type CloneFailure,
  type CloneOptions,
} from "./control-plane-session-clone.ts";
import { createSession, resumeSession } from "./control-plane-sessions.ts";
import { isCreateSessionConflict } from "./db/plane-storage-sessions.ts";

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

/** Durable clone reads the source authoritatively, then conditionally writes a new id. */
export async function cloneSessionDurable(
  state: ControlPlaneState,
  sessionId: string,
  opts: CloneOptions = {},
): Promise<{ ok: true; session: PublicSession; created: true } | CloneFailure> {
  if (state.storage) {
    const [source, commands, providers, accounts] = await Promise.all([
      state.storage.getSession(sessionId),
      state.storage.listCommands(),
      state.storage.listProviders(),
      state.storage.listProviderAccounts(),
    ]);
    if (!source) return { ok: false, error: "session not found", code: "NOT_FOUND" };
    state.sessions.set(source.id, { ...source });
    state.commands = new Map(commands.map((command) => [command.id, command]));
    state.providers = new Map(providers.map((provider) => [provider.id, provider]));
    state.providerAccounts = new Map(accounts.map((account) => [account.id, account]));
  }
  const prepared = prepareClonedSession(state, sessionId, opts);
  if (!prepared.ok) return prepared;
  if (!state.storage) {
    state.sessions.set(prepared.session.id, { ...prepared.session });
    return { ok: true, session: toPublic(state, prepared.session), created: true };
  }
  try {
    const result = await state.storage.createSession(prepared.session);
    state.sessions.set(result.session.id, { ...result.session });
    // A clone never supplies a concurrency id, so a successful durable create
    // must always be a new session. Keep this guard in case a custom storage
    // implementation violates that contract.
    if (!result.created)
      return {
        ok: false,
        error: "clone creation conflicted; retry the request",
        code: "CONFLICT",
      };
    return { ok: true, session: toPublic(state, result.session), created: true };
  } catch (err) {
    if (isCreateSessionConflict(err)) {
      return {
        ok: false,
        error: "clone creation conflicted; retry the request",
        code: "CONFLICT",
      };
    }
    throw err;
  }
}
