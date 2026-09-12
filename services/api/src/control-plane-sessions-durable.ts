/* eslint-disable max-lines -- durable create, resume, clone, and webhook fences share admission semantics. */
import type { PublicSession } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { noteSlackSessionLifecycle, toPublic } from "./control-plane-state.ts";
import { buildSessionRecord, validateSessionCreate } from "./control-plane-session-create.ts";
import { prepareResumedSession, type ResumeOptions } from "./control-plane-session-resume.ts";
import {
  prepareClonedSession,
  type CloneFailure,
  type CloneOptions,
} from "./control-plane-session-clone.ts";
import { createSession, resumeSession } from "./control-plane-sessions.ts";
import {
  isCreateSessionConflict,
  isRepositoryAdmissionClosed,
  sessionDrainOperationId,
} from "./db/plane-storage-sessions.ts";
import { getSessionDurable as getSessionRecordDurable } from "./control-plane-durable-read-runtime.ts";
import {
  getRepositoryDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import { referenceMarkers } from "./control-plane-delete-reference-markers.ts";
import { getWorkspacePoolDurable } from "./control-plane-workspace-pools.ts";
import type { IntegrationSessionFence } from "./db/plane-storage-types.ts";

function sessionDrainFailure(
  error: unknown,
): { ok: false; error: string; code: "DRAINING"; operationId: string } | undefined {
  const operationId = sessionDrainOperationId(error);
  return operationId
    ? {
        ok: false,
        error: "principal session admission is draining",
        code: "DRAINING",
        operationId,
      }
    : undefined;
}

export async function createSessionDurable(
  state: ControlPlaneState,
  body: unknown,
  options: {
    principalId?: string;
    integrationFence?: IntegrationSessionFence;
    allowCustomWebhookConcurrencyId?: boolean;
    allowGitHubCommentConcurrencyId?: boolean;
  } = {},
): Promise<
  | { ok: true; session: PublicSession; created: boolean }
  | { ok: false; error: string; code?: string; operationId?: string }
> {
  if (!state.storage) {
    if (options.integrationFence && !matchesIntegrationFence(state, options.integrationFence)) {
      return {
        ok: false,
        error: "integration changed concurrently",
        code: "CONFLICT",
      };
    }
    return createSession(
      state,
      body,
      {
        ...(options.allowCustomWebhookConcurrencyId
          ? { allowCustomWebhookConcurrencyId: true }
          : {}),
        ...(options.allowGitHubCommentConcurrencyId
          ? { allowGitHubCommentConcurrencyId: true }
          : {}),
      },
    );
  }
  await refreshTargetCatalogDurable(state);
  if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { repositoryId?: unknown }).repositoryId === "string"
  ) {
    await getRepositoryDurable(state, (body as { repositoryId: string }).repositoryId);
  } else if (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { workspacePoolId?: unknown }).workspacePoolId === "string"
  ) {
    await getWorkspacePoolDurable(state, (body as { workspacePoolId: string }).workspacePoolId);
  }
  const prepared = validateSessionCreate(
    state,
    body,
    {
      ...(options.allowCustomWebhookConcurrencyId
        ? { allowCustomWebhookConcurrencyId: true }
        : {}),
      ...(options.allowGitHubCommentConcurrencyId
        ? { allowGitHubCommentConcurrencyId: true }
        : {}),
    },
  );
  if (!prepared.ok) return prepared;
  if (options.integrationFence && !matchesIntegrationFence(state, options.integrationFence)) {
    return {
      ok: false,
      error: "integration changed concurrently",
      code: "CONFLICT",
    };
  }
  let result;
  try {
    const session = buildSessionRecord(state, prepared, options.principalId);
    result = await state.storage.createSession(
      session,
      referenceMarkers(state.now(), session),
      undefined,
      options.integrationFence,
    );
  } catch (err) {
    const draining = sessionDrainFailure(err);
    if (draining) return draining;
    if (isRepositoryAdmissionClosed(err)) {
      return {
        ok: false,
        error: "repository admission is closed",
        code: "REPOSITORY_ADMISSION_CLOSED",
      };
    }
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
  noteSlackSessionLifecycle(state, result.session);
  return { ok: true, session: toPublic(state, result.session), created: result.created };
}

/** Trusted custom-webhook ingress alone may mint its concurrency namespace. */
export function createCustomWebhookSessionDurable(
  state: ControlPlaneState,
  body: unknown,
  options: { integrationFence?: IntegrationSessionFence } = {},
): ReturnType<typeof createSessionDurable> {
  return createSessionDurable(state, body, {
    ...options,
    allowCustomWebhookConcurrencyId: true,
  });
}

/** Trusted GitHub ingress alone may mint the comment-delivery concurrency namespace. */
export function createGitHubIngressSessionDurable(
  state: ControlPlaneState,
  body: unknown,
  options: { integrationFence?: IntegrationSessionFence } = {},
): ReturnType<typeof createSessionDurable> {
  return createSessionDurable(state, body, {
    ...options,
    allowGitHubCommentConcurrencyId: true,
  });
}

function matchesIntegrationFence(
  state: ControlPlaneState,
  fence: IntegrationSessionFence,
): boolean {
  if (fence.type === "github-ingress") {
    const current = state.githubIngressConfig;
    return (
      !!current &&
      current.id === fence.id &&
      current.type === fence.type &&
      current.version === fence.version &&
      current.enabled === fence.enabled
    );
  }
  const current = state.customWebhookIntegrations.get(fence.id);
  return (
    !!current &&
    current.type === fence.type &&
    current.generation === fence.generation &&
    current.version === fence.version &&
    current.enabled === fence.enabled
  );
}

/** Durable resume uses the same concurrency lock as a fresh create. */
export async function resumeSessionDurable(
  state: ControlPlaneState,
  sessionId: string,
  opts: ResumeOptions = {},
): Promise<
  | { ok: true; session: PublicSession; created: boolean }
  | { ok: false; error: string; code?: string; operationId?: string }
> {
  if (!state.storage) {
    return resumeSession(state, sessionId, opts);
  }
  await getSessionRecordDurable(state, sessionId);
  const source = state.sessions.get(sessionId);
  if (source?.repositoryId) await getRepositoryDurable(state, source.repositoryId);
  // A target override validates against state.commands/state.providers, which a cold
  // Lambda has not populated — gated so an ordinary resume pays nothing extra.
  if (opts.target !== undefined) await refreshTargetCatalogDurable(state);
  const prepared = prepareResumedSession(state, sessionId, opts);
  if (!prepared.ok) return prepared;
  // The storage transaction below is the only concurrency authority.
  let result;
  try {
    result = await state.storage.createSession(
      prepared.session,
      referenceMarkers(state.now(), prepared.session),
    );
  } catch (err) {
    const draining = sessionDrainFailure(err);
    if (draining) return draining;
    if (isRepositoryAdmissionClosed(err)) {
      return {
        ok: false,
        error: "repository admission is closed",
        code: "REPOSITORY_ADMISSION_CLOSED",
      };
    }
    if (isCreateSessionConflict(err)) {
      return { ok: false, error: "session creation conflicted; retry the request" };
    }
    throw err;
  }
  state.sessions.set(result.session.id, { ...result.session });
  noteSlackSessionLifecycle(state, result.session);
  return { ok: true, session: toPublic(state, result.session), created: result.created };
}

/** Durable clone reads the source authoritatively, then conditionally writes a new id. */
export async function cloneSessionDurable(
  state: ControlPlaneState,
  sessionId: string,
  opts: CloneOptions = {},
): Promise<{ ok: true; session: PublicSession; created: true } | CloneFailure> {
  let cloneState = state;
  if (state.storage) {
    const [source, commands, providers, accounts] = await Promise.all([
      state.storage.getSession(sessionId),
      state.storage.listCommands(),
      state.storage.listProviders(),
      state.storage.listProviderAccounts(),
    ]);
    if (!source) return { ok: false, error: "session not found", code: "NOT_FOUND" };
    const [repository, workspacePool] = await Promise.all([
      source.repositoryId
        ? state.storage.getRepository(source.repositoryId)
        : Promise.resolve(null),
      source.workspacePoolId
        ? state.storage.getWorkspacePool(source.workspacePoolId)
        : Promise.resolve(null),
    ]);
    state.sessions.set(source.id, { ...source });
    // Catalog scans are an authorization-time snapshot. Keep them isolated so
    // a concurrent management write cannot be erased from the shared cache.
    cloneState = {
      ...state,
      commands: new Map(commands.map((command) => [command.id, command])),
      providers: new Map(providers.map((provider) => [provider.id, provider])),
      providerAccounts: new Map(accounts.map((account) => [account.id, account])),
      repositories: new Map(repository ? [[repository.id, repository]] : []),
      workspacePools: new Map(workspacePool ? [[workspacePool.id, workspacePool]] : []),
    };
  }
  const prepared = prepareClonedSession(cloneState, sessionId, opts);
  if (!prepared.ok) return prepared;
  if (!state.storage) {
    state.sessions.set(prepared.session.id, { ...prepared.session });
    return { ok: true, session: toPublic(state, prepared.session), created: true };
  }
  try {
    const result = await state.storage.createSession(
      prepared.session,
      referenceMarkers(state.now(), prepared.session),
    );
    state.sessions.set(result.session.id, { ...result.session });
    if (result.created) noteSlackSessionLifecycle(state, result.session);
    if (!result.created)
      return {
        ok: false,
        error: "clone creation conflicted; retry the request",
        code: "CONFLICT",
      };
    return { ok: true, session: toPublic(state, result.session), created: true };
  } catch (err) {
    const draining = sessionDrainFailure(err);
    if (draining) return draining;
    if (isRepositoryAdmissionClosed(err)) {
      return {
        ok: false,
        error: "repository admission is closed",
        code: "REPOSITORY_ADMISSION_CLOSED",
      };
    }
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
