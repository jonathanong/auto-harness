import type { PublicSession, ScheduleRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { queueWrite } from "./control-plane-state.ts";
import { createSession } from "./control-plane-sessions.ts";

export function putSchedule(
  state: ControlPlaneState,
  input: {
    repositoryId: string;
    name: string;
    commandProfile: string;
    cron: string;
    timeout: number;
    nextRunAt: string;
    enabled?: boolean;
    ref?: string;
    id?: string;
  },
): ScheduleRecord {
  const id = input.id ?? state.scheduleIdFactory();
  const rec: ScheduleRecord = {
    id,
    repositoryId: input.repositoryId,
    name: input.name,
    commandProfile: input.commandProfile,
    cron: input.cron,
    enabled: input.enabled ?? true,
    timeout: input.timeout,
    nextRunAt: input.nextRunAt,
    lastRunAt: null,
    createdAt: state.now(),
    ...(input.ref !== undefined ? { ref: input.ref } : {}),
  };
  state.schedules.set(id, rec);
  if (state.storage) {
    queueWrite(state, state.storage.putSchedule({ ...rec }));
  }
  return { ...rec };
}

export function getSchedule(state: ControlPlaneState, id: string): ScheduleRecord | null {
  const s = state.schedules.get(id);
  return s ? { ...s } : null;
}

export function listSchedules(state: ControlPlaneState): ScheduleRecord[] {
  return [...state.schedules.values()].map((s) => ({ ...s }));
}

export function updateSchedule(
  state: ControlPlaneState,
  id: string,
  patch: Partial<{
    name: string;
    commandProfile: string;
    cron: string;
    timeout: number;
    nextRunAt: string;
    enabled: boolean;
    ref: string;
    repositoryId: string;
  }>,
): { ok: true; schedule: ScheduleRecord } | { ok: false; error: string } {
  const existing = state.schedules.get(id);
  if (!existing) {
    return { ok: false, error: "schedule not found" };
  }
  const next: ScheduleRecord = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.commandProfile !== undefined ? { commandProfile: patch.commandProfile } : {}),
    ...(patch.cron !== undefined ? { cron: patch.cron } : {}),
    ...(patch.timeout !== undefined ? { timeout: patch.timeout } : {}),
    ...(patch.nextRunAt !== undefined ? { nextRunAt: patch.nextRunAt } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.repositoryId !== undefined ? { repositoryId: patch.repositoryId } : {}),
    ...(patch.ref !== undefined ? { ref: patch.ref } : {}),
  };
  state.schedules.set(id, next);
  if (state.storage) {
    queueWrite(state, state.storage.putSchedule({ ...next }));
  }
  return { ok: true, schedule: { ...next } };
}

export function deleteSchedule(
  state: ControlPlaneState,
  id: string,
): { ok: true } | { ok: false; error: string } {
  if (!state.schedules.has(id)) {
    return { ok: false, error: "schedule not found" };
  }
  state.schedules.delete(id);
  if (state.storage) {
    queueWrite(state, state.storage.deleteSchedule(id));
  }
  return { ok: true };
}

/**
 * Manual trigger: creates one scheduled session and advances nextRunAt
 * (same provenance as cron: type/source schedule).
 */
export function triggerSchedule(
  state: ControlPlaneState,
  id: string,
  nowIso: string = state.now(),
): { ok: true; session: PublicSession } | { ok: false; error: string } {
  const schedule = state.schedules.get(id);
  if (!schedule) {
    return { ok: false, error: "schedule not found" };
  }
  if (!schedule.enabled) {
    return { ok: false, error: "schedule is disabled" };
  }
  schedule.nextRunAt = new Date(Date.parse(nowIso) + 60_000).toISOString();
  schedule.lastRunAt = nowIso;
  if (state.storage) {
    queueWrite(state, state.storage.putSchedule({ ...schedule }));
  }
  const result = createSession(state, {
    repositoryId: schedule.repositoryId,
    prompt: `scheduled:${schedule.name}`,
    commandProfile: schedule.commandProfile,
    timeout: schedule.timeout,
    type: "scheduled",
    source: "schedule",
    ...(schedule.ref !== undefined ? { ref: schedule.ref } : {}),
  });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, session: result.session };
}

/**
 * Cron evaluation with conditional nextRunAt claim (Invariant 4).
 * Concurrent callers: only one advances nextRunAt and creates a session.
 */
export function evaluateCron(
  state: ControlPlaneState,
  nowIso: string = state.now(),
): PublicSession[] {
  const created: PublicSession[] = [];
  const nowMs = Date.parse(nowIso);
  for (const schedule of state.schedules.values()) {
    if (!schedule.enabled) {
      continue;
    }
    if (Date.parse(schedule.nextRunAt) > nowMs) {
      continue;
    }
    const fired = tryClaimScheduleFire(state, schedule.id, schedule.nextRunAt, nowIso);
    if (fired) {
      created.push(fired);
    }
  }
  return created;
}

/**
 * Concurrent-safe claim used by tests: only the first caller with matching expectedNextRunAt wins.
 */
export function tryClaimScheduleFire(
  state: ControlPlaneState,
  scheduleId: string,
  expectedNextRunAt: string,
  nowIso: string,
): PublicSession | null {
  const schedule = state.schedules.get(scheduleId);
  if (!schedule || !schedule.enabled) {
    return null;
  }
  if (schedule.nextRunAt !== expectedNextRunAt) {
    return null;
  }
  if (Date.parse(expectedNextRunAt) > Date.parse(nowIso)) {
    return null;
  }
  schedule.nextRunAt = new Date(Date.parse(nowIso) + 60_000).toISOString();
  schedule.lastRunAt = nowIso;
  const result = createSession(state, {
    repositoryId: schedule.repositoryId,
    prompt: `scheduled:${schedule.name}`,
    commandProfile: schedule.commandProfile,
    timeout: schedule.timeout,
    type: "scheduled",
    source: "schedule",
    ...(schedule.ref !== undefined ? { ref: schedule.ref } : {}),
  });
  if (!result.ok) {
    return null;
  }
  return result.session;
}
