/* eslint-disable max-lines */
import { MAX_FALLBACKS, isValidUtcTimestamp, nextCronOccurrence } from "@auto-harness/shared";
import type { PublicSession, ScheduleRecord } from "./control-plane-types.ts";
import type { SessionRecord } from "./db/types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import {
  hashString,
  noteSlackSessionLifecycle,
  queueWrite,
  toPublic,
} from "./control-plane-state.ts";
import { createSession } from "./control-plane-sessions.ts";
import { resolveTargetLabels } from "./control-plane-session-target-label.ts";
import {
  getRepositoryDurable,
  getScheduleDurable,
  listSchedulesDurable,
  refreshTargetCatalogDurable,
} from "./control-plane-durable-read-catalog.ts";
import { scheduledSessionPrompt } from "./control-plane-schedule-prompt.ts";
import {
  repositoryAdmissionFailure,
  repositoryAdmissionOpen,
} from "./control-plane-repository-admission-state.ts";
import { newAuditRecord, SYSTEM_AUDIT_ACTOR } from "./audit.ts";
import type { AuditLogRecord } from "./audit-types.ts";

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

async function disableLegacyFallbackTrigger(
  state: ControlPlaneState,
  schedule: ScheduleRecord,
  fallbackCount: number,
): Promise<{ ok: false; error: string }> {
  const disabled = await disableLegacyFallbackSchedule(
    state,
    schedule,
    schedule.nextRunAt,
    fallbackCount,
  );
  if (disabled) state.schedules.set(schedule.id, { ...schedule, enabled: false });
  return {
    ok: false,
    error: disabled
      ? `schedule disabled: it has ${fallbackCount} persisted fallbacks; update it to at most ${MAX_FALLBACKS}`
      : "schedule changed concurrently; legacy fallback disable was not applied",
  };
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
): Promise<
  | { ok: true; session: PublicSession; created: boolean }
  | { ok: false; error: string; code?: "DRAINING" | undefined; operationId?: string | undefined }
> {
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
  if (!schedule.principalId) {
    return { ok: false, error: "schedule must be claimed by an authenticated principal" };
  }
  const repository = await getRepositoryDurable(state, schedule.repositoryId);
  if (!repository || repositoryAdmissionFailure(state, schedule.repositoryId)) {
    return { ok: false, error: "repository admission is closed" };
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
    ...(repository.activationCutoffAt ? { activationCutoffAt: repository.activationCutoffAt } : {}),
    session,
  });
  if (outcome.kind === "duplicate") {
    state.sessions.set(outcome.session.id, { ...outcome.session });
    return { ok: true, session: toPublic(state, outcome.session), created: false };
  }
  if (outcome.kind === "admission_closed") {
    return { ok: false, error: "repository admission is closed" };
  }
  if (outcome.kind === "draining") {
    return {
      ok: false,
      error: "principal session admission is draining",
      code: "DRAINING",
      operationId: outcome.operationId,
    };
  }
  if (outcome.kind === "legacy_fallbacks") {
    return disableLegacyFallbackTrigger(state, schedule, outcome.fallbackCount);
  }
  if (outcome.kind !== "created") {
    return { ok: false, error: "schedule was updated or claimed concurrently" };
  }
  state.schedules.set(id, { ...schedule, nextRunAt: newNextRunAt, lastRunAt: nowIso });
  state.sessions.set(session.id, session);
  noteSlackSessionLifecycle(state, session);
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
  const activationCutoffAt = state.repositories.get(schedule.repositoryId)?.activationCutoffAt;
  if (activationCutoffAt && Date.parse(expectedNextRunAt) < Date.parse(activationCutoffAt)) {
    schedule.nextRunAt = newNextRunAt;
    return null;
  }
  const target = resolveScheduledTarget(state, schedule);
  if (!target.ok) {
    return null;
  }
  const result = createSession(state, scheduledSessionInput(schedule), { allowScheduleId: true });
  if (!result.ok) {
    if (result.code === "REPOSITORY_ADMISSION_CLOSED") schedule.nextRunAt = newNextRunAt;
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
    // An audit/storage outage for one schedule must not stall every other due
    // schedule. Its cursor was not advanced, so this schedule remains retryable.
    try {
      const session = await tryClaimScheduleFireDurable(
        state,
        schedule.id,
        schedule.nextRunAt,
        nowIso,
      );
      if (session) created.push(session);
    } catch {
      continue;
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
  const repository = await getRepositoryDurable(state, schedule.repositoryId);
  if (!repository) return null;
  const activationCutoffAt = repository.activationCutoffAt;
  if (activationCutoffAt && Date.parse(expectedNextRunAt) < Date.parse(activationCutoffAt)) {
    let skipped = false;
    if (repositoryAdmissionOpen(repository.admissionState)) {
      skipped = await state.storage.skipScheduleBeforeActivationCutoff({
        scheduleId,
        repositoryId: schedule.repositoryId,
        activationCutoffAt,
        expectedNextRunAt,
        newNextRunAt,
      });
    }
    if (!skipped) {
      skipped = await state.storage.skipScheduleForClosedRepository({
        scheduleId,
        repositoryId: schedule.repositoryId,
        expectedNextRunAt,
        newNextRunAt,
      });
    }
    if (skipped) state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt });
    return null;
  }
  if (!schedule.principalId) {
    // Legacy rows without an authenticated owner cannot safely author a
    // session. Consume this occurrence with the same cursor CAS used by a
    // normal claim so cron does not hot-loop until an operator claims it.
    const audit = ownerlessSkipAudit(state, schedule);
    const skipped = await state.storage.skipOwnerlessScheduleAndAudit({
      scheduleId,
      expectedNextRunAt,
      newNextRunAt,
      lastRunAt: nowIso,
      audit,
    });
    if (skipped) {
      state.schedules.set(scheduleId, {
        ...schedule,
        nextRunAt: newNextRunAt,
        lastRunAt: nowIso,
      });
      state.auditLogs.set(audit.id, audit);
    }
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
    ...(activationCutoffAt
      ? {
          activationCutoffAt,
          expectedNextRunAtEpochMs: Date.parse(expectedNextRunAt),
        }
      : {}),
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
  if (outcome.kind === "admission_closed") {
    // The failed create is advisory: this transaction is the authoritative
    // closed observation because it also CASes the cursor. Activation uses the
    // same primitive before changing admission to active, so either caller
    // consumes this occurrence while closed or a competing cursor update wins.
    const skipped = await state.storage.skipScheduleForClosedRepository({
      scheduleId,
      repositoryId: schedule.repositoryId,
      expectedNextRunAt,
      newNextRunAt,
    });
    if (skipped) state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt });
    return null;
  }
  if (outcome.kind === "draining") {
    const audit = principalDrainSkipAudit(state, schedule, outcome.operationId);
    const skipped = await state.storage.skipScheduleForPrincipalDrainAndAudit({
      scheduleId,
      repositoryId: schedule.repositoryId,
      principalId: schedule.principalId!,
      operationId: outcome.operationId,
      expectedNextRunAt,
      newNextRunAt,
      audit,
    });
    if (skipped) {
      state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt });
      state.auditLogs.set(audit.id, audit);
    }
    return null;
  }
  if (outcome.kind === "legacy_fallbacks") {
    const disabled = await disableLegacyFallbackSchedule(
      state,
      schedule,
      expectedNextRunAt,
      outcome.fallbackCount,
    );
    if (disabled) {
      state.schedules.set(scheduleId, { ...schedule, enabled: false });
    }
    return null;
  }
  if (outcome.kind !== "created") {
    return null;
  }
  state.schedules.set(scheduleId, { ...schedule, nextRunAt: newNextRunAt, lastRunAt: nowIso });
  state.sessions.set(session.id, session);
  noteSlackSessionLifecycle(state, session);
  return toPublic(state, session);
}

function ownerlessSkipAudit(state: ControlPlaneState, schedule: ScheduleRecord): AuditLogRecord {
  return newAuditRecord(
    {
      actor: SYSTEM_AUDIT_ACTOR,
      action: "schedule:ownerless-occurrence-skipped",
      resourceType: "schedule",
      resourceId: schedule.id,
      repositoryId: schedule.repositoryId,
      outcome: "failed",
      metadata: { reason: "schedule must be claimed by an authenticated principal" },
    },
    state.now(),
    state.auditIdFactory(),
  );
}

function principalDrainSkipAudit(
  state: ControlPlaneState,
  schedule: ScheduleRecord,
  operationId: string,
): AuditLogRecord {
  return newAuditRecord(
    {
      actor: SYSTEM_AUDIT_ACTOR,
      action: "session-drain:admission-rejected",
      resourceType: "schedule",
      resourceId: schedule.id,
      repositoryId: schedule.repositoryId,
      outcome: "failed",
      metadata: { operationId, principalId: schedule.principalId! },
    },
    state.now(),
    state.auditIdFactory(),
  );
}

function disableLegacyFallbackSchedule(
  state: ControlPlaneState,
  schedule: ScheduleRecord,
  expectedNextRunAt: string,
  fallbackCount: number,
): Promise<boolean> {
  const audit = newAuditRecord(
    {
      actor: SYSTEM_AUDIT_ACTOR,
      action: "schedule:legacy-fallbacks-disabled",
      resourceType: "schedule",
      resourceId: schedule.id,
      repositoryId: schedule.repositoryId,
      outcome: "failed",
      metadata: {
        reason: "persisted schedule exceeds the durable transaction route limit",
        fallbackCount,
        maxFallbacks: MAX_FALLBACKS,
      },
    },
    state.now(),
    state.auditIdFactory(),
  );
  return state
    .storage!.disableLegacyFallbackScheduleAndAudit({
      scheduleId: schedule.id,
      expectedNextRunAt,
      audit,
    })
    .then((disabled) => {
      if (disabled) state.auditLogs.set(audit.id, audit);
      return disabled;
    });
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
    ...(schedule.principalId ? { principalId: schedule.principalId } : {}),
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
  metadata?: Record<string, unknown>;
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
    ...(schedule.principalId ? { metadata: { createdBy: schedule.principalId } } : {}),
  };
}
