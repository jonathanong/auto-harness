import { isValidScheduledBranchRef, validateTargetRouting } from "@auto-harness/shared";

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
  nextRunAt: string;
  enabled?: boolean;
  ref?: string;
  id?: string;
};

export function putSchedule(
  state: ControlPlaneState,
  input: ScheduleInput,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  if (input.ref !== undefined && !isValidScheduledBranchRef(input.ref)) {
    return { ok: false, error: "ref must be a valid scheduled branch name" };
  }
  const routing = validateTargetRouting(input);
  if (!routing.ok) return routing;
  const labels = resolveTargetLabels(state, routing.value.target, routing.value.fallbacks);
  if (!labels.ok) return labels;
  const rec: ScheduleRecord = {
    id: input.id ?? state.scheduleIdFactory(),
    repositoryId: input.repositoryId,
    name: input.name,
    target: routing.value.target,
    fallbacks: routing.value.fallbacks,
    targetLabels: labels.labels,
    cron: input.cron,
    enabled: input.enabled ?? true,
    timeout: input.timeout,
    queueTtlSeconds: routing.value.queueTtlSeconds,
    nextRunAt: input.nextRunAt,
    lastRunAt: null,
    createdAt: state.now(),
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
  };
  state.schedules.set(rec.id, rec);
  if (state.storage) queueWrite(state, state.storage.putSchedule({ ...rec }));
  return { ok: true, schedule: { ...rec } };
}

export function getSchedule(state: ControlPlaneState, id: string): ScheduleRecord | null {
  const schedule = state.schedules.get(id);
  return schedule ? { ...schedule } : null;
}

export function listSchedules(state: ControlPlaneState): ScheduleRecord[] {
  return [...state.schedules.values()].map((schedule) => ({ ...schedule }));
}

export function updateSchedule(
  state: ControlPlaneState,
  id: string,
  patch: Partial<Omit<ScheduleInput, "id">>,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  const existing = state.schedules.get(id);
  if (!existing) return { ok: false, error: "schedule not found" };
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
  };
  state.schedules.set(id, next);
  if (state.storage) queueWrite(state, state.storage.putSchedule({ ...next }));
  return { ok: true, schedule: { ...next } };
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
