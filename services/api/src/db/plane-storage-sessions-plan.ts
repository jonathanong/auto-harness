import { transitionEffect, type SessionTransitionPlan } from "../session-transition-planner.ts";
import type { SessionRecord } from "./types.ts";
import { finishSession } from "./plane-storage-sessions-terminal.ts";
import {
  requeueUsageLimitedSession,
  suppressProviderlessUsageLimit,
} from "./plane-storage-sessions-usage-limit.ts";

function firstDefined<T>(primary: T | undefined, fallback: T | undefined): T | undefined {
  if (primary !== undefined) return primary;
  return fallback;
}

function hostLeaseForSession(session: SessionRecord): SessionRecord["hostAssignmentLease"] {
  return (
    session.hostAssignmentLease ??
    (session.hostId && (session.status === "running" || session.status === "cancelled")
      ? { hostId: session.hostId }
      : undefined)
  );
}

function reportFieldsFromPlan(plan: SessionTransitionPlan): {
  exitCode?: number | null;
  errorCode?: string;
  errorMessage?: string;
  cliResumeRef?: string;
} {
  const finish = transitionEffect(plan, "finish");
  const requeue = transitionEffect(plan, "requeue");
  const exitCode = firstDefined(finish?.exitCode, requeue?.exitCode);
  const errorCode = firstDefined(finish?.errorCode, requeue?.errorCode);
  const errorMessage = firstDefined(finish?.errorMessage, requeue?.errorMessage);
  const cliResumeRef = firstDefined(finish?.cliResumeRef, requeue?.cliResumeRef);
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
  };
}

/** Build finishSession arguments from finish/requeue effects. */
export function finishSessionOptsFromPlan(
  session: SessionRecord,
  plan: SessionTransitionPlan,
  extras: { attemptId: string; fence?: { hostId: string; connectionId: string } },
): Parameters<typeof finishSession>[1] {
  const finish = transitionEffect(plan, "finish");
  const queued = transitionEffect(plan, "requeue") !== undefined && finish === undefined;
  return {
    sessionId: session.id,
    worktreeId: session.worktreeId ?? null,
    attemptId: extras.attemptId,
    status: finish?.status ?? "queued",
    queueShard: session.queueShard,
    ...(queued || finish?.completedAt === undefined ? {} : { completedAt: finish.completedAt }),
    ...reportFieldsFromPlan(plan),
    ...(extras.fence ? { fence: extras.fence } : {}),
    ...(session.concurrencyId !== undefined ? { concurrencyId: session.concurrencyId } : {}),
    ...(session.providerAccountLease ? { providerAccountLease: session.providerAccountLease } : {}),
    ...(hostLeaseForSession(session) ? { hostAssignmentLease: hostLeaseForSession(session) } : {}),
  };
}

/** Map planner cooldown+requeue effects onto the usage-limit worktree write. */
export function requeueUsageLimitedSessionOptsFromPlan(
  session: SessionRecord,
  plan: SessionTransitionPlan,
  extras: { now: string; attemptId: string },
): Parameters<typeof requeueUsageLimitedSession>[1] {
  const cooldown = transitionEffect(plan, "cooldown")!;
  const requeue = transitionEffect(plan, "requeue");
  return {
    sessionId: session.id,
    worktreeId: session.worktreeId!,
    attemptId: extras.attemptId,
    providerAccountId: cooldown.providerAccountId,
    queueShard: session.queueShard,
    now: extras.now,
    usageLimitedUntil: cooldown.usageLimitedUntil,
    ...(requeue?.errorMessage ? { errorMessage: requeue.errorMessage } : {}),
    ...(session.providerAccountLease ? { providerAccountLease: session.providerAccountLease } : {}),
    ...(hostLeaseForSession(session) ? { hostAssignmentLease: hostLeaseForSession(session) } : {}),
  };
}

/** Map planner suppress+requeue effects onto the providerless usage-limit write. */
export function suppressProviderlessUsageLimitOptsFromPlan(
  session: SessionRecord,
  plan: SessionTransitionPlan,
  extras: { attemptId: string },
): Parameters<typeof suppressProviderlessUsageLimit>[1] {
  const suppress = transitionEffect(plan, "suppress_target")!;
  const requeue = transitionEffect(plan, "requeue");
  return {
    sessionId: session.id,
    worktreeId: session.worktreeId!,
    attemptId: extras.attemptId,
    queueShard: session.queueShard,
    targetIndex: suppress.targetIndex,
    ...(requeue?.errorMessage ? { errorMessage: requeue.errorMessage } : {}),
    ...(session.providerAccountLease ? { providerAccountLease: session.providerAccountLease } : {}),
    ...(hostLeaseForSession(session) ? { hostAssignmentLease: hostLeaseForSession(session) } : {}),
  };
}
