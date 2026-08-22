import {
  concurrencyIdByteLengthError,
  isActiveSessionStatus,
  isReservedConcurrencyId,
  isValidScheduledBranchRef,
  isValidUtcTimestamp,
  nextCronOccurrence,
  validateTargetRouting,
} from "@auto-harness/shared";

import type { ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { resolveTargetLabels } from "./control-plane-session-target-label.ts";
import {
  getScheduleDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import { referenceMarkers } from "./control-plane-delete-reference-markers.ts";
import {
  applyStoredPrompt,
  storedSchedulePrompt,
  type ScheduleInput,
} from "./control-plane-schedule-prompt.ts";

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
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
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
  const labels = resolveTargetLabels(state, routing.value.target, routing.value.fallbacks);
  if (!labels.ok) return labels;
  const id = input.id ?? state.scheduleIdFactory();
  const concurrencyId = input.concurrencyId?.trim() || `schedule-${id}`;
  if (isReservedConcurrencyId(concurrencyId))
    return { ok: false, error: "concurrencyId uses a reserved internal prefix" };
  const concurrencyIdBytes = concurrencyIdByteLengthError(concurrencyId);
  if (concurrencyIdBytes) return { ok: false, error: concurrencyIdBytes };
  const prompt = storedSchedulePrompt(input.prompt);
  const rec: ScheduleRecord = {
    id,
    repositoryId: input.repositoryId,
    name: input.name,
    target: routing.value.target,
    fallbacks: routing.value.fallbacks,
    targetLabels: labels.labels,
    cron: input.cron,
    enabled: input.enabled ?? true,
    timeout: input.timeout,
    queueTtlSeconds: routing.value.queueTtlSeconds,
    nextRunAt,
    lastRunAt: null,
    createdAt: now,
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
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
  if (!state.storage) return putSchedule(state, input);
  await refreshTargetCatalogDurable(state);
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
  const now = state.now();
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
  const labels = resolveTargetLabels(state, routing.value.target, routing.value.fallbacks);
  if (!labels.ok) return labels;
  const next: ScheduleRecord = {
    ...existing,
    ...patch,
    target: routing.value.target,
    fallbacks: routing.value.fallbacks,
    targetLabels: labels.labels,
    queueTtlSeconds: routing.value.queueTtlSeconds,
    nextRunAt,
    concurrencyId,
  };
  if (patch.prompt !== undefined) applyStoredPrompt(next, patch.prompt);
  return { ok: true, schedule: next };
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
  if (!(await getScheduleDurable(state, id))) return { ok: false, error: "schedule not found" };
  await state.storage.deleteSchedule(id);
  state.schedules.delete(id);
  return { ok: true };
}
