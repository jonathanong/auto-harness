/* eslint-disable max-lines */
import type { PublicSession } from "./control-plane-types.ts";
import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, queueWrite, toPublic } from "./control-plane-state.ts";
import { createSession } from "./control-plane-sessions.ts";

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
    ...(schedule.providerAccountId !== undefined
      ? { providerAccountId: schedule.providerAccountId }
      : {}),
    ...(schedule.commandId !== undefined ? { commandId: schedule.commandId } : {}),
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
    ...(schedule.providerAccountId !== undefined
      ? { providerAccountId: schedule.providerAccountId }
      : {}),
    ...(schedule.commandId !== undefined ? { commandId: schedule.commandId } : {}),
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

/** Durable cron evaluator; DynamoDB owns the nextRunAt compare-and-swap. */
export async function evaluateCronDurable(
  state: ControlPlaneState,
  nowIso: string = state.now(),
): Promise<PublicSession[]> {
  if (!state.storage) {
    return evaluateCron(state, nowIso);
  }
  const created: PublicSession[] = [];
  const nowMs = Date.parse(nowIso);
  for (const schedule of state.schedules.values()) {
    if (!schedule.enabled || Date.parse(schedule.nextRunAt) > nowMs) {
      continue;
    }
    const session = await tryClaimScheduleFireDurable(
      state,
      schedule.id,
      schedule.nextRunAt,
      nowIso,
    );
    if (session) {
      created.push(session);
    }
  }
  return created;
}

/** Atomically claim one schedule and create exactly one scheduled session. */
export async function tryClaimScheduleFireDurable(
  state: ControlPlaneState,
  scheduleId: string,
  expectedNextRunAt: string,
  nowIso: string,
): Promise<PublicSession | null> {
  if (!state.storage) {
    return tryClaimScheduleFire(state, scheduleId, expectedNextRunAt, nowIso);
  }
  const schedule = state.schedules.get(scheduleId);
  if (!schedule || !schedule.enabled || schedule.nextRunAt !== expectedNextRunAt) {
    return null;
  }
  if (Date.parse(expectedNextRunAt) > Date.parse(nowIso)) {
    return null;
  }
  const id = state.idFactory();
  const createdAt = state.now();
  const session: SessionRecord = {
    id,
    repositoryId: schedule.repositoryId,
    prompt: `scheduled:${schedule.name}`,
    ...(schedule.providerAccountId !== undefined
      ? { providerAccountId: schedule.providerAccountId }
      : {}),
    ...(schedule.commandId !== undefined ? { commandId: schedule.commandId } : {}),
    targetLabel: schedule.targetLabel,
    timeout: schedule.timeout,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt,
    retryCount: 0,
    type: "scheduled",
    source: "schedule",
    ...(schedule.ref !== undefined ? { ref: schedule.ref } : {}),
  };
  const newNextRunAt = new Date(Date.parse(nowIso) + 60_000).toISOString();
  const won = await state.storage.tryClaimScheduleAndCreateSession({
    scheduleId,
    expectedNextRunAt,
    newNextRunAt,
    lastRunAt: nowIso,
    session,
  });
  if (!won) {
    return null;
  }
  state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt, lastRunAt: nowIso });
  state.sessions.set(id, session);
  return toPublic(state, session);
}
