/* eslint-disable max-lines -- schedule validation and durable cursor operations share one boundary. */
import {
  concurrencyIdByteLengthError,
  isActiveSessionStatus,
  isReservedConcurrencyId,
  isValidScheduledBranchRef,
  isValidUtcTimestamp,
  nextCronOccurrence,
  validateTargetRouting,
} from "@auto-harness/shared";
import { repositoryAdmissionFailure } from "./control-plane-repository-admission-state.ts";

import type { ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { resolveTargetDisplayNames } from "./control-plane-session-target-display-name.ts";
import {
  getRepositoryDurable,
  getScheduleDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import {
  principalDeletionMarker,
  referenceMarkers,
} from "./control-plane-delete-reference-markers.ts";
import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";
import { isConditionalTransactionFailed } from "./db/plane-storage-types.ts";
import {
  applyStoredPrompt,
  storedSchedulePrompt,
  type ScheduleInput,
} from "./control-plane-schedule-prompt.ts";
import { getWorkspacePoolDurable } from "./control-plane-workspace-pools.ts";

export {
  evaluateCron,
  evaluateCronDurable,
  triggerSchedule,
  triggerScheduleDurable,
  tryClaimScheduleFire,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";

export function putSchedule(
  state: ControlPlaneState,
  input: ScheduleInput,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string; code?: string } {
  const result = preparePutSchedule(state, input);
  if (!result.ok) return result;
  state.schedules.set(result.schedule.id, result.schedule);
  if (state.storage) queueWrite(state, (storage) => storage!.putSchedule({ ...result.schedule }));
  return { ok: true, schedule: { ...result.schedule } };
}

function preparePutSchedule(
  state: ControlPlaneState,
  input: ScheduleInput,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  const mode = validateScheduleMode(state, input);
  if (!mode.ok) return mode;
  const now = state.now();
  if (!isValidUtcTimestamp(now)) {
    return { ok: false, error: "server clock must be an ISO-8601 UTC timestamp" };
  }
  if (input.ref !== undefined && !isValidScheduledBranchRef(input.ref)) {
    return { ok: false, error: "ref must be a valid scheduled branch name" };
  }
  if (input.nextRunAt !== undefined && !isValidUtcTimestamp(input.nextRunAt)) {
    return { ok: false, error: "nextRunAt must be an ISO-8601 UTC timestamp" };
  }
  const nextRunAt = nextCronOccurrence(input.cron, now);
  if (!nextRunAt) {
    return { ok: false, error: "cron must be a valid five-field UTC expression" };
  }
  const routing = validateTargetRouting(input);
  if (!routing.ok) return routing;
  const displayNames = resolveTargetDisplayNames(
    state,
    routing.value.target,
    routing.value.fallbacks,
  );
  if (!displayNames.ok) return displayNames;
  const id = input.id ?? state.scheduleIdFactory();
  const concurrencyId = input.concurrencyId?.trim() || `schedule-${id}`;
  if (isReservedConcurrencyId(concurrencyId))
    return { ok: false, error: "concurrencyId uses a reserved internal prefix" };
  const concurrencyIdBytes = concurrencyIdByteLengthError(concurrencyId);
  if (concurrencyIdBytes) return { ok: false, error: concurrencyIdBytes };
  const prompt = storedSchedulePrompt(input.prompt);
  // Authenticated routes always supply their principal. Direct/in-memory use
  // is the authentication-disabled control plane and therefore owns newly
  // created schedules as the same durable system principal used by that route.
  // Only rows persisted before schedule ownership existed remain ownerless.
  const principalId = input.principalId ?? "system";
  const rec: ScheduleRecord = {
    id,
    repositoryId: mode.repositoryId,
    principalId,
    name: input.name,
    target: routing.value.target,
    fallbacks: routing.value.fallbacks,
    targetDisplayNames: displayNames.displayNames,
    cron: input.cron,
    enabled: input.enabled ?? true,
    timeout: input.timeout,
    queueTtlSeconds: routing.value.queueTtlSeconds,
    nextRunAt,
    lastRunAt: null,
    createdAt: now,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
    ...(mode.workspacePoolId ? { workspacePoolId: mode.workspacePoolId } : {}),
    ...(mode.setupProfileId ? { setupProfileId: mode.setupProfileId } : {}),
    ...(mode.workspacePoolId
      ? { destroyWorkspaceAfter: input.destroyWorkspaceAfter ?? mode.poolDefaultCleanup }
      : {}),
    concurrencyId,
    ...(prompt !== undefined ? { prompt } : {}),
  };
  return { ok: true, schedule: rec };
}

/** Persist a schedule before making it visible to this control-plane process. */
export async function putScheduleDurable(
  state: ControlPlaneState,
  input: ScheduleInput,
): Promise<ReturnType<typeof putSchedule>> {
  if (!state.storage) {
    const mode = validateScheduleMode(state, input);
    if (!mode.ok) return mode;
    if (mode.repositoryId && !state.repositories.has(mode.repositoryId)) {
      return { ok: false, error: "repository not found" };
    }
    const admissionFailure = mode.repositoryId
      ? repositoryAdmissionFailure(state, mode.repositoryId)
      : undefined;
    if (admissionFailure) return admissionFailure;
    return putSchedule(state, input);
  }
  await refreshTargetCatalogDurable(state);
  if (
    (input.repositoryId === null || input.repositoryId === "") &&
    typeof input.workspacePoolId === "string"
  ) {
    await getWorkspacePoolDurable(state, input.workspacePoolId);
  }
  const mode = validateScheduleMode(state, input);
  if (!mode.ok) return mode;
  if (mode.repositoryId) {
    const repository = await getRepositoryDurable(state, mode.repositoryId);
    if (!repository) return { ok: false, error: "repository not found" };
    const admissionFailure = repositoryAdmissionFailure(state, mode.repositoryId);
    if (admissionFailure) return admissionFailure;
  } else {
    if (!state.workspacePools.has(mode.workspacePoolId!)) {
      return { ok: false, error: "workspace pool not found" };
    }
  }
  const result = preparePutSchedule(state, input);
  if (!result.ok) return result;
  await state.storage.putSchedule(
    { ...result.schedule },
    referenceMarkers(state.now(), result.schedule),
  );
  state.schedules.set(result.schedule.id, result.schedule);
  return { ok: true, schedule: { ...result.schedule } };
}

export function getSchedule(state: ControlPlaneState, id: string): ScheduleRecord | null {
  const s = state.schedules.get(id);
  return s ? withActiveSession(state, s) : null;
}

export function listSchedules(state: ControlPlaneState): ScheduleRecord[] {
  return [...state.schedules.values()].map((s) => withActiveSession(state, s));
}

function withActiveSession(state: ControlPlaneState, schedule: ScheduleRecord): ScheduleRecord {
  const concurrencyId = schedule.concurrencyId?.trim() || `schedule-${schedule.id}`;
  const active = [...state.sessions.values()].find(
    (session) => session.concurrencyId === concurrencyId && isActiveSessionStatus(session.status),
  );
  return { ...schedule, concurrencyId, activeSessionId: active?.id ?? null };
}

export function updateSchedule(
  state: ControlPlaneState,
  id: string,
  patch: Partial<Omit<ScheduleInput, "id">>,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  const result = prepareUpdateSchedule(state, id, patch);
  if (!result.ok) return result;
  state.schedules.set(id, result.schedule);
  if (state.storage) queueWrite(state, (storage) => storage!.putSchedule({ ...result.schedule }));
  return { ok: true, schedule: { ...result.schedule } };
}

export function prepareUpdateSchedule(
  state: ControlPlaneState,
  id: string,
  patch: Partial<Omit<ScheduleInput, "id">>,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  const existing = state.schedules.get(id);
  if (!existing) return { ok: false, error: "schedule not found" };
  if (
    existing.principalId &&
    Object.hasOwn(patch, "principalId") &&
    patch.principalId !== existing.principalId
  ) {
    return { ok: false, error: "schedule ownership cannot be transferred" };
  }
  const now = state.now();
  const mergedInput: ScheduleInput = {
    ...existing,
    ...patch,
    repositoryId:
      patch.repositoryId !== undefined ? patch.repositoryId : existing.repositoryId || null,
  };
  if (mergedInput.repositoryId !== null && mergedInput.repositoryId !== "") {
    delete mergedInput.workspacePoolId;
    delete mergedInput.setupProfileId;
    delete mergedInput.destroyWorkspaceAfter;
  } else {
    delete mergedInput.ref;
  }
  const mode = validateScheduleMode(state, mergedInput);
  if (!mode.ok) return mode;
  if (!isValidUtcTimestamp(now)) {
    return { ok: false, error: "server clock must be an ISO-8601 UTC timestamp" };
  }
  if (patch.nextRunAt !== undefined && !isValidUtcTimestamp(patch.nextRunAt)) {
    return { ok: false, error: "nextRunAt must be an ISO-8601 UTC timestamp" };
  }
  const nextRunAt = nextCronOccurrence(patch.cron ?? existing.cron, now);
  if (!nextRunAt) {
    return { ok: false, error: "cron must be a valid five-field UTC expression" };
  }
  if (patch.ref !== undefined && !isValidScheduledBranchRef(patch.ref)) {
    return { ok: false, error: "ref must be a valid scheduled branch name" };
  }
  const concurrencyId =
    patch.concurrencyId !== undefined
      ? patch.concurrencyId.trim() || `schedule-${id}`
      : existing.concurrencyId?.trim() || `schedule-${id}`;
  if (isReservedConcurrencyId(concurrencyId)) {
    return { ok: false, error: "concurrencyId uses a reserved internal prefix" };
  }
  const concurrencyIdBytes = concurrencyIdByteLengthError(concurrencyId);
  if (concurrencyIdBytes) return { ok: false, error: concurrencyIdBytes };
  const routing = validateTargetRouting({
    target: patch.target ?? existing.target,
    fallbacks: patch.fallbacks ?? existing.fallbacks,
    queueTtlSeconds: patch.queueTtlSeconds ?? existing.queueTtlSeconds,
  });
  if (!routing.ok) return routing;
  const displayNames = resolveTargetDisplayNames(
    state,
    routing.value.target,
    routing.value.fallbacks,
  );
  if (!displayNames.ok) return displayNames;
  const schedulePatch = { ...patch };
  delete (schedulePatch as Record<string, unknown>).requiredLabels;
  delete (schedulePatch as Record<string, unknown>).setupScript;
  const next: ScheduleRecord = {
    ...existing,
    ...schedulePatch,
    repositoryId: mode.repositoryId,
    target: routing.value.target,
    fallbacks: routing.value.fallbacks,
    targetDisplayNames: displayNames.displayNames,
    queueTtlSeconds: routing.value.queueTtlSeconds,
    nextRunAt,
    concurrencyId,
  };
  if (mode.repositoryId) {
    delete next.workspacePoolId;
    delete next.setupProfileId;
    delete next.destroyWorkspaceAfter;
  } else {
    delete next.ref;
    if (mode.workspacePoolId) next.workspacePoolId = mode.workspacePoolId;
    if (mode.setupProfileId) next.setupProfileId = mode.setupProfileId;
    else delete next.setupProfileId;
    next.destroyWorkspaceAfter = Boolean(
      mergedInput.destroyWorkspaceAfter ?? mode.poolDefaultCleanup,
    );
  }
  if (patch.prompt !== undefined) applyStoredPrompt(next, patch.prompt);
  return { ok: true, schedule: next };
}

type ScheduleMode =
  | {
      ok: true;
      repositoryId: string;
      workspacePoolId?: undefined;
      setupProfileId?: undefined;
      poolDefaultCleanup?: undefined;
    }
  | {
      ok: true;
      repositoryId: "";
      workspacePoolId: string;
      setupProfileId?: string;
      poolDefaultCleanup: boolean;
    };

function validateScheduleMode(
  state: ControlPlaneState,
  input: ScheduleInput,
): ScheduleMode | { ok: false; error: string } {
  if (input.setupScript !== undefined) {
    return { ok: false, error: "setupScript is not accepted by schedule inputs" };
  }
  if (input.requiredLabels !== undefined && !Array.isArray(input.requiredLabels)) {
    return { ok: false, error: "requiredLabels must be an array" };
  }
  if (Array.isArray(input.requiredLabels) && input.requiredLabels.length > 0) {
    return { ok: false, error: "requiredLabels are not supported by schedule inputs" };
  }
  const workspace = input.repositoryId === null || input.repositoryId === "";
  if (!workspace) {
    if (typeof input.repositoryId !== "string" || !input.repositoryId.trim()) {
      return { ok: false, error: "repositoryId is required" };
    }
    if (
      input.workspacePoolId !== undefined ||
      input.setupProfileId !== undefined ||
      input.destroyWorkspaceAfter !== undefined
    ) {
      return { ok: false, error: "workspace fields require repositoryId to be null" };
    }
    return { ok: true, repositoryId: input.repositoryId };
  }
  if (input.workspacePoolId === undefined || !input.workspacePoolId.trim()) {
    return { ok: false, error: "workspacePoolId is required for workspace schedules" };
  }
  if (input.ref !== undefined)
    return { ok: false, error: "ref is not supported for workspace schedules" };
  if (input.setupProfileId !== undefined && !input.setupProfileId.trim()) {
    return { ok: false, error: "setupProfileId must not be empty" };
  }
  if (
    input.destroyWorkspaceAfter !== undefined &&
    typeof input.destroyWorkspaceAfter !== "boolean"
  ) {
    return { ok: false, error: "destroyWorkspaceAfter must be a boolean" };
  }
  const pool = state.workspacePools.get(input.workspacePoolId);
  if (!pool) return { ok: false, error: "workspace pool not found" };
  if (
    input.setupProfileId &&
    !pool.setupProfiles.some((profile) => profile.id === input.setupProfileId)
  ) {
    return { ok: false, error: "workspace setup profile not found" };
  }
  return {
    ok: true,
    repositoryId: "",
    workspacePoolId: input.workspacePoolId,
    ...(input.setupProfileId ? { setupProfileId: input.setupProfileId } : {}),
    poolDefaultCleanup: pool.destroyWorkspaceAfter,
  };
}

export function deleteSchedule(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.schedules.has(id)) return { ok: false, error: "schedule not found" };
  state.schedules.delete(id);
  if (state.storage) queueWrite(state, (storage) => storage!.deleteSchedule(id));
  return { ok: true };
}

/** Delete durable state before removing the schedule from the cache. */
export async function deleteScheduleDurable(
  state: ControlPlaneState,
  id: string,
): Promise<ReturnType<typeof deleteSchedule>> {
  if (!state.storage) return deleteSchedule(state, id);
  const cached = await getScheduleDurable(state, id);
  if (!cached) return { ok: false, error: "schedule not found" };
  const marker = principalDeletionMarker(cached.principalId);
  return withDeletionMarkers(state, marker ? [marker] : [], async (owner) => {
    // Re-read after acquiring the owner fence so an account deletion and a
    // schedule deletion linearize around the same principal marker.
    const schedule = await getScheduleDurable(state, id);
    if (!schedule) return { ok: false, error: "schedule not found" };
    try {
      await state.storage!.deleteSchedule(
        id,
        owner ? [{ key: marker!, owner, now: state.now() }] : undefined,
      );
    } catch (error) {
      if (isConditionalTransactionFailed(error)) {
        return {
          ok: false,
          conflict: true,
          error: "catalog deletion lease was lost; retry the request",
        };
      }
      throw error;
    }
    state.schedules.delete(id);
    return { ok: true };
  });
}
