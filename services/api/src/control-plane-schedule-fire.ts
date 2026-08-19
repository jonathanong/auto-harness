/* eslint-disable max-lines */
import { isValidUtcTimestamp, nextCronOccurrence } from "@auto-harness/shared";
import type { PublicSession, ScheduleRecord } from "./control-plane-types.ts";
import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { hashString, queueWrite, toPublic } from "./control-plane-state.ts";
import { createSession } from "./control-plane-sessions.ts";
import { resolveTargetLabels } from "./control-plane-session-target-label.ts";
import {
  getScheduleDurable,
  listSchedulesDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import { scheduledSessionPrompt } from "./control-plane-schedule-prompt.ts";

const PERSISTED_ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Manual trigger: creates one scheduled session and advances nextRunAt
 * (same provenance as cron: type/source schedule).
 */
export function triggerSchedule(
  state: ControlPlaneState,
  id: string,
  nowIso: string = state.now(),
): { ok: true; session: PublicSession; created: boolean } | { ok: false; error: string } {
  const schedule = state.schedules.get(id);
  if (!schedule) {
    return { ok: false, error: "schedule not found" };
  }
  if (!schedule.enabled) {
    return { ok: false, error: "schedule is disabled" };
  }
  const newNextRunAt = nextRunAt(schedule, nowIso);
  if (!newNextRunAt) return { ok: false, error: "invalid schedule cron or timestamp" };
  const target = resolveScheduledTarget(state, schedule);
  if (!target.ok) {
    return target;
  }
  const result = createSession(state, scheduledSessionInput(schedule), { allowScheduleId: true });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  if (result.created) {
    schedule.nextRunAt = newNextRunAt;
    schedule.lastRunAt = nowIso;
    if (state.storage) {
      const scheduleSnapshot = { ...schedule };
      queueWrite(state, (storage) => storage!.putSchedule(scheduleSnapshot));
    }
  }
  return { ok: true, session: result.session, created: result.created };
}

/**
 * Durable manual trigger. Unlike cron, an operator-triggered run is allowed
 * before nextRunAt; the expected cursor still prevents two API processes from
 * creating duplicate sessions or advancing the schedule independently.
 */
export async function triggerScheduleDurable(
  state: ControlPlaneState,
  id: string,
  nowIso: string = state.now(),
): Promise<{ ok: true; session: PublicSession; created: boolean } | { ok: false; error: string }> {
  if (!state.storage) {
    return triggerSchedule(state, id, nowIso);
  }
  await refreshTargetCatalogDurable(state);
  const schedule = await getScheduleDurable(state, id);
  if (!schedule) {
    return { ok: false, error: "schedule not found" };
  }
  if (!schedule.enabled) {
    return { ok: false, error: "schedule is disabled" };
  }
  const newNextRunAt = nextRunAt(schedule, nowIso);
  if (!newNextRunAt) return { ok: false, error: "invalid schedule cron or timestamp" };
  const target = resolveScheduledTarget(state, schedule);
  if (!target.ok) {
    return target;
  }
  const session = createScheduledSession(state, schedule);
  const outcome = await state.storage.tryClaimScheduleAndCreateSession({
    scheduleId: id,
    expectedNextRunAt: schedule.nextRunAt,
    newNextRunAt,
    lastRunAt: nowIso,
    session,
  });
  if (outcome.kind === "duplicate") {
    state.sessions.set(outcome.session.id, { ...outcome.session });
    return { ok: true, session: toPublic(state, outcome.session), created: false };
  }
  if (outcome.kind !== "created") {
    return { ok: false, error: "schedule was updated or claimed concurrently" };
  }
  state.schedules.set(id, { ...schedule, nextRunAt: newNextRunAt, lastRunAt: nowIso });
  state.sessions.set(session.id, session);
  return { ok: true, session: toPublic(state, session), created: true };
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
  if (!isValidUtcTimestamp(nowIso)) return created;
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
  const newNextRunAt = nextRunAt(schedule, nowIso);
  if (!newNextRunAt) return null;
  if (schedule.nextRunAt !== expectedNextRunAt) {
    return null;
  }
  if (Date.parse(expectedNextRunAt) > Date.parse(nowIso)) {
    return null;
  }
  const target = resolveScheduledTarget(state, schedule);
  if (!target.ok) {
    return null;
  }
  const result = createSession(state, scheduledSessionInput(schedule), { allowScheduleId: true });
  if (!result.ok) {
    return null;
  }
  schedule.nextRunAt = newNextRunAt;
  if (!result.created) {
    return null;
  }
  schedule.lastRunAt = nowIso;
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
  await refreshTargetCatalogDurable(state);
  await listSchedulesDurable(state);
  const created: PublicSession[] = [];
  if (!isValidUtcTimestamp(nowIso)) return created;
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
  await refreshTargetCatalogDurable(state);
  const schedule = await getScheduleDurable(state, scheduleId);
  if (!schedule || !schedule.enabled || schedule.nextRunAt !== expectedNextRunAt) {
    return null;
  }
  const newNextRunAt = nextRunAt(schedule, nowIso);
  if (!newNextRunAt) return null;
  if (Date.parse(expectedNextRunAt) > Date.parse(nowIso)) {
    return null;
  }
  const target = resolveScheduledTarget(state, schedule);
  if (!target.ok) {
    return null;
  }
  const session = createScheduledSession(state, schedule);
  const outcome = await state.storage.tryClaimScheduleAndCreateSession({
    scheduleId,
    expectedNextRunAt,
    newNextRunAt,
    lastRunAt: nowIso,
    session,
  });
  if (outcome.kind === "duplicate") {
    const skipped = await state.storage.skipScheduleForActiveConcurrency({
      scheduleId,
      expectedNextRunAt,
      newNextRunAt,
      concurrencyId: session.concurrencyId!,
      sessionId: outcome.session.id,
    });
    if (skipped) {
      state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt });
      state.sessions.set(outcome.session.id, { ...outcome.session });
    }
    return null;
  }
  if (outcome.kind !== "created") {
    return null;
  }
  state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt, lastRunAt: nowIso });
  state.sessions.set(session.id, session);
  return toPublic(state, session);
}

function nextRunAt(schedule: ScheduleRecord, nowIso: string): string | null {
  if (!isValidPersistedCursor(schedule.nextRunAt) || !isValidUtcTimestamp(nowIso)) return null;
  return nextCronOccurrence(schedule.cron, nowIso);
}

/**
 * The API accepts only canonical UTC cursors, but pre-existing persisted rows
 * may use an ISO offset. Keep that original value for the storage CAS and
 * normalize only the newly-derived cursor written after a successful claim.
 */
function isValidPersistedCursor(value: string): boolean {
  return PERSISTED_ISO_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function createScheduledSession(state: ControlPlaneState, schedule: ScheduleRecord): SessionRecord {
  const id = state.idFactory();
  const createdAt = state.now();
  return {
    id,
    repositoryId: schedule.repositoryId,
    prompt: scheduledSessionPrompt(schedule),
    target: schedule.target,
    fallbacks: [...schedule.fallbacks],
    targetLabels: [...schedule.targetLabels],
    queueTtlSeconds: schedule.queueTtlSeconds,
    queueExpiresAt: new Date(Date.parse(createdAt) + schedule.queueTtlSeconds * 1000).toISOString(),
    timeout: schedule.timeout,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: Math.abs(hashString(id)) % state.shardCount,
    createdAt,
    type: "scheduled",
    source: "schedule",
    ...(schedule.ref !== undefined ? { ref: schedule.ref } : {}),
    concurrencyId: schedule.concurrencyId ?? `schedule-${schedule.id}`,
    scheduleId: schedule.id,
  };
}

function resolveScheduledTarget(
  state: ControlPlaneState,
  schedule: ScheduleRecord,
): { ok: true; labels: string[] } | { ok: false; error: string } {
  return resolveTargetLabels(state, schedule.target, schedule.fallbacks);
}

function scheduledSessionInput(schedule: ScheduleRecord): {
  repositoryId: string;
  prompt: string;
  target: import("@auto-harness/shared").TargetRef;
  fallbacks: import("@auto-harness/shared").TargetRef[];
  timeout: number;
  queueTtlSeconds: number;
  type: string;
  source: string;
  ref?: string;
  concurrencyId?: string;
  scheduleId?: string;
} {
  return {
    repositoryId: schedule.repositoryId,
    prompt: scheduledSessionPrompt(schedule),
    target: schedule.target,
    fallbacks: schedule.fallbacks,
    timeout: schedule.timeout,
    queueTtlSeconds: schedule.queueTtlSeconds,
    type: "scheduled",
    source: "schedule",
    ...(schedule.ref !== undefined ? { ref: schedule.ref } : {}),
    concurrencyId: schedule.concurrencyId ?? `schedule-${schedule.id}`,
    scheduleId: schedule.id,
  };
}
