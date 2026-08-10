import {
  isActiveSessionStatus,
  isValidScheduledBranchRef,
  isValidUtcTimestamp,
  nextCronOccurrence,
  validateTargetRouting,
} from "@auto-harness/shared";

import type { ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { resolveTargetLabels } from "./control-plane-session-target-label.ts";

export {
  evaluateCron,
  evaluateCronDurable,
  triggerSchedule,
  triggerScheduleDurable,
  tryClaimScheduleFire,
  tryClaimScheduleFireDurable,
} from "./control-plane-schedule-fire.ts";

type ScheduleInput = {
  repositoryId: string;
  name: string;
  target: unknown;
  fallbacks?: unknown;
  cron: string;
  timeout: number;
  queueTtlSeconds?: number;
  /** Legacy client input. The server validates it but always derives the cursor. */
  nextRunAt?: string;
  enabled?: boolean;
  ref?: string;
  concurrencyId?: string;
  id?: string;
};

export function putSchedule(
  state: ControlPlaneState,
  input: ScheduleInput,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  const result = preparePutSchedule(state, input);
  if (!result.ok) return result;
  state.schedules.set(result.schedule.id, result.schedule);
  if (state.storage) queueWrite(state, state.storage.putSchedule({ ...result.schedule }));
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
    concurrencyId: input.concurrencyId?.trim() || `schedule-${id}`,
  };
  return { ok: true, schedule: rec };
}

/** Persist a schedule before making it visible to this control-plane process. */
export async function putScheduleDurable(
  state: ControlPlaneState,
  input: ScheduleInput,
): Promise<ReturnType<typeof putSchedule>> {
  if (!state.storage) return putSchedule(state, input);
  const result = preparePutSchedule(state, input);
  if (!result.ok) return result;
  await state.storage.putSchedule({ ...result.schedule });
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
  if (state.storage) queueWrite(state, state.storage.putSchedule({ ...result.schedule }));
  return { ok: true, schedule: { ...result.schedule } };
}

function prepareUpdateSchedule(
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
    ...(patch.concurrencyId !== undefined
      ? { concurrencyId: patch.concurrencyId.trim() || `schedule-${id}` }
      : {}),
  };
  return { ok: true, schedule: next };
}

/** Persist a schedule update before replacing the cache entry. */
export async function updateScheduleDurable(
  state: ControlPlaneState,
  id: string,
  patch: Parameters<typeof updateSchedule>[2],
): Promise<ReturnType<typeof updateSchedule>> {
  if (!state.storage) return updateSchedule(state, id, patch);
  const result = prepareUpdateSchedule(state, id, patch);
  if (!result.ok) return result;
  const saved = await state.storage.updateScheduleManagement({ ...result.schedule });
  if (!saved) {
    state.schedules.delete(id);
    return { ok: false, error: "schedule not found" };
  }
  state.schedules.set(id, saved);
  return { ok: true, schedule: { ...saved } };
}

export function deleteSchedule(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.schedules.has(id)) return { ok: false, error: "schedule not found" };
  state.schedules.delete(id);
  if (state.storage) queueWrite(state, state.storage.deleteSchedule(id));
  return { ok: true };
}

/** Delete durable state before removing the schedule from the cache. */
export async function deleteScheduleDurable(
  state: ControlPlaneState,
  id: string,
): Promise<ReturnType<typeof deleteSchedule>> {
  if (!state.storage) return deleteSchedule(state, id);
  if (!state.schedules.has(id)) return { ok: false, error: "schedule not found" };
  await state.storage.deleteSchedule(id);
  state.schedules.delete(id);
  return { ok: true };
}
