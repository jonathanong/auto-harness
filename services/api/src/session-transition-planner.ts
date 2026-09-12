/* eslint-disable max-lines -- one policy table covers every host and lifecycle event. */
import {
  isTerminalSessionStatus,
  type SessionResult,
  type SessionStatus,
} from "@auto-harness/shared";

import type { SessionRecord } from "./db/types.ts";

type SessionReportFields = {
  exitCode?: number | null;
  errorCode?: string;
  errorMessage?: string;
  cliResumeRef?: string;
  result?: SessionResult;
};

export type SessionTransitionEvent =
  | { type: "ack"; worktreeId: string | null; attemptId: string }
  | { type: "command_start"; worktreeId: string | null; attemptId: string }
  | ({
      type: "status";
      worktreeId: string | null;
      attemptId: string;
      status: SessionStatus;
    } & SessionReportFields)
  | { type: "cancel" }
  | { type: "timeout" }
  | { type: "disconnect"; acknowledged: boolean }
  | { type: "infrastructure_failure"; code: "checkout_fetch_failed" | "host_lost" }
  | { type: "queue_expired" }
  | { type: "log"; attemptId: string }
  | { type: "reconnect_claim"; attemptId: string };

type SessionTransitionIgnoreReason =
  | "stale_attempt"
  | "already_acked"
  | "not_running"
  | "non_terminal"
  | "not_due"
  | "not_queued"
  | "missing_account";

export type SessionTransitionEffect =
  | { type: "ignore"; reason: SessionTransitionIgnoreReason }
  | { type: "reject"; error: string }
  | { type: "ack" }
  | { type: "authorize_command_start" }
  | { type: "retry_archive" }
  | ({
      type: "patch_report";
      status?: SessionStatus;
    } & SessionReportFields)
  | ({
      type: "finish";
      status: SessionStatus;
      completedAt: string;
      clearResumeRef?: boolean;
    } & SessionReportFields)
  | ({
      type: "requeue";
      reason: "usage_limit" | "missing_account" | "providerless" | "disconnect" | "infrastructure";
    } & SessionReportFields)
  | { type: "cooldown"; providerAccountId: string; usageLimitedUntil: string }
  | { type: "suppress_target"; targetIndex: number }
  | { type: "fallback" }
  | { type: "release_worktree" }
  | { type: "release_lease" }
  | { type: "archive" }
  | { type: "reschedule"; kind: "prompt" | "scheduled" }
  | { type: "notify_cancel" }
  | { type: "cancel"; holdAssignment: boolean }
  | { type: "mark_reconnect"; deadlineAt: string };

export type SessionTransitionPlan = { effects: SessionTransitionEffect[] };

export type SessionTransitionContext = {
  now: string;
  source: "local" | "durable";
  providerAccount?: { usageLimitCooldownSeconds: number } | null;
  reconnectGraceMs?: number;
};

/** A session may replay a safe, pre-command infrastructure failure once. */
const MAX_INFRASTRUCTURE_RETRIES = 1;

export function transitionEffect<T extends SessionTransitionEffect["type"]>(
  plan: SessionTransitionPlan,
  type: T,
): Extract<SessionTransitionEffect, { type: T }> | undefined {
  return plan.effects.find(
    (effect): effect is Extract<SessionTransitionEffect, { type: T }> => effect.type === type,
  );
}

function planOf(...effects: SessionTransitionEffect[]): SessionTransitionPlan {
  return { effects };
}

function attemptMatches(
  session: SessionRecord,
  worktreeId: string | null,
  attemptId: string,
): boolean {
  return session.worktreeId === worktreeId && session.attemptId === attemptId;
}

function remainingFallback(session: SessionRecord): boolean {
  return (session.resolvedRoute?.targetIndex ?? 0) < (session.fallbacks?.length ?? 0);
}

function report(event: Extract<SessionTransitionEvent, { type: "status" }>): SessionReportFields {
  return {
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
    ...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
    ...(event.cliResumeRef !== undefined ? { cliResumeRef: event.cliResumeRef } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
  };
}

function scheduleKind(session: SessionRecord): "prompt" | "scheduled" {
  return session.type === "scheduled" ? "scheduled" : "prompt";
}

function releaseEffects(session: SessionRecord): SessionTransitionEffect[] {
  if (session.mainCheckoutLease) return [{ type: "release_lease" }];
  return session.worktreeId ? [{ type: "release_worktree" }] : [];
}

/** Only the first valid ACK is a state transition. Retried or stale frames stay idempotent. */
function planAck(
  session: SessionRecord,
  event: Extract<SessionTransitionEvent, { type: "ack" }>,
): SessionTransitionPlan {
  if (session.status !== "running" || !attemptMatches(session, event.worktreeId, event.attemptId)) {
    return planOf({ type: "ignore", reason: "stale_attempt" });
  }
  if (session.ackReceivedAt !== undefined)
    return planOf({ type: "ignore", reason: "already_acked" });
  return planOf({ type: "ack" });
}

function planCommandStart(
  session: SessionRecord,
  event: Extract<SessionTransitionEvent, { type: "command_start" }>,
): SessionTransitionPlan {
  if (session.status !== "running" || !attemptMatches(session, event.worktreeId, event.attemptId)) {
    return planOf({ type: "ignore", reason: "stale_attempt" });
  }
  // A duplicate command-start is a successful no-op. The durable writer owns
  // the exact conditional fence; the planner keeps local workers idempotent.
  if (session.primaryCommandStartState === "authorized") return planOf();
  if (session.primaryCommandStartState !== "pending") {
    return planOf({ type: "reject", error: "command start is not enabled for this assignment" });
  }
  return planOf({ type: "authorize_command_start" });
}

function planInfrastructureFailure(
  session: SessionRecord,
  code: "checkout_fetch_failed" | "host_lost",
  ctx: SessionTransitionContext,
  detail?: string,
  fields: SessionReportFields = {},
): SessionTransitionPlan {
  if (session.status !== "running") return planOf({ type: "ignore", reason: "not_running" });
  const baseMessage =
    detail ??
    (code === "checkout_fetch_failed"
      ? "checkout fetch failed"
      : "host was lost before command launch");
  const replaySafe = code !== "host_lost" || session.primaryCommandStartState === "pending";
  if (replaySafe && (session.infrastructureRetryCount ?? 0) < MAX_INFRASTRUCTURE_RETRIES) {
    return planOf(
      ...releaseEffects(session),
      {
        type: "requeue",
        reason: "infrastructure",
        errorCode: code,
        errorMessage: `${baseMessage}; retrying once`,
      },
      { type: "reschedule", kind: scheduleKind(session) },
    );
  }
  return planOf(
    ...releaseEffects(session),
    {
      type: "finish",
      status: "failed",
      completedAt: ctx.now,
      ...fields,
      errorCode: code,
      errorMessage: replaySafe
        ? `${baseMessage}; automatic retry exhausted`
        : "host lost after command authorization or without a replay-safe checkpoint",
    },
    { type: "archive" },
  );
}

function planUsageLimit(
  session: SessionRecord,
  event: Extract<SessionTransitionEvent, { type: "status" }>,
  ctx: SessionTransitionContext,
): SessionTransitionEffect[] {
  const leased = Boolean(session.mainCheckoutLease);
  const accountId = session.resolvedRoute?.providerAccountId;
  const fallback = remainingFallback(session) ? [{ type: "fallback" as const }] : [];
  const reschedule: SessionTransitionEffect = { type: "reschedule", kind: scheduleKind(session) };
  const release = releaseEffects(session);
  const fields = report(event);

  if (accountId && ctx.providerAccount) {
    return [
      {
        type: "cooldown",
        providerAccountId: accountId,
        usageLimitedUntil: new Date(
          Date.parse(ctx.now) + ctx.providerAccount.usageLimitCooldownSeconds * 1000,
        ).toISOString(),
      },
      ...release,
      ...fallback,
      {
        type: "requeue",
        reason: "usage_limit",
        errorCode: "usage_limit",
        errorMessage: event.errorMessage ?? "provider usage limit; requeued",
        ...fields,
      },
      reschedule,
    ];
  }
  if (accountId) {
    if (ctx.source === "durable" && !leased) {
      return [{ type: "ignore", reason: "missing_account" }];
    }
    const missing = ctx.source === "durable" && leased;
    return [
      ...release,
      {
        type: "requeue",
        reason: missing ? "missing_account" : "usage_limit",
        errorCode: "usage_limit",
        errorMessage: missing
          ? "provider account missing; requeued"
          : (event.errorMessage ?? "provider usage limit; requeued"),
        ...fields,
      },
      reschedule,
    ];
  }
  return [
    { type: "suppress_target", targetIndex: session.resolvedRoute?.targetIndex ?? 0 },
    ...release,
    ...fallback,
    {
      type: "requeue",
      reason: "providerless",
      errorCode: "usage_limit",
      ...fields,
    },
    reschedule,
  ];
}

function planLateTerminal(
  session: SessionRecord,
  event: Extract<SessionTransitionEvent, { type: "status" }>,
  ctx: SessionTransitionContext,
  prefix: SessionTransitionEffect[],
): SessionTransitionPlan {
  const cancelled = session.status === "cancelled";
  if (ctx.source === "durable" && !cancelled) {
    return planOf(...prefix, { type: "ignore", reason: "not_running" });
  }
  if (ctx.source === "durable" && cancelled && !session.worktreeId && !session.mainCheckoutLease) {
    return planOf(...prefix, { type: "ignore", reason: "not_running" });
  }
  return planOf(
    ...prefix,
    ...releaseEffects(session),
    ...(event.cliResumeRef !== undefined || event.result !== undefined
      ? [
          {
            type: "patch_report" as const,
            ...(event.cliResumeRef !== undefined ? { cliResumeRef: event.cliResumeRef } : {}),
            ...(event.result !== undefined ? { result: event.result } : {}),
          },
        ]
      : []),
  );
}

function planStatus(
  session: SessionRecord,
  event: Extract<SessionTransitionEvent, { type: "status" }>,
  ctx: SessionTransitionContext,
): SessionTransitionPlan {
  const terminal = isTerminalSessionStatus(event.status);
  const prefix: SessionTransitionEffect[] =
    ctx.source === "durable" && terminal && isTerminalSessionStatus(session.status)
      ? [{ type: "retry_archive" }]
      : [];
  if (!attemptMatches(session, event.worktreeId, event.attemptId)) {
    return planOf(...prefix, { type: "ignore", reason: "stale_attempt" });
  }
  if (!terminal) {
    if (ctx.source === "local") {
      return planOf({
        type: "patch_report",
        ...(session.status === "running"
          ? { status: event.status, ...report(event) }
          : event.cliResumeRef !== undefined
            ? { cliResumeRef: event.cliResumeRef }
            : {}),
      });
    }
    return planOf({ type: "ignore", reason: "non_terminal" });
  }
  if (session.status !== "running") return planLateTerminal(session, event, ctx, prefix);
  if (event.status === "failed" && event.errorCode === "usage_limit") {
    return planOf(...planUsageLimit(session, event, ctx));
  }
  if (event.status === "failed" && event.errorCode === "checkout_fetch_failed") {
    return planInfrastructureFailure(
      session,
      "checkout_fetch_failed",
      ctx,
      event.errorMessage,
      report(event),
    );
  }
  return planOf(
    ...releaseEffects(session),
    {
      type: "finish",
      status: event.status,
      completedAt: ctx.now,
      ...report(event),
      ...(session.resumedFromSessionId && event.cliResumeRef === undefined
        ? { clearResumeRef: true }
        : {}),
    },
    { type: "archive" },
  );
}

function planAttemptId(
  session: SessionRecord,
  attemptId: string,
  requireRunning = false,
): SessionTransitionPlan {
  if (
    (requireRunning && session.status !== "running") ||
    (session.attemptId !== undefined && session.attemptId !== attemptId)
  ) {
    return planOf({ type: "ignore", reason: "stale_attempt" });
  }
  return planOf();
}

function planCancel(session: SessionRecord): SessionTransitionPlan {
  if (isTerminalSessionStatus(session.status)) {
    return planOf({
      type: "reject",
      error: `session already terminal: ${session.status}`,
    });
  }
  if (session.status === "running" && session.hostId) {
    return planOf({ type: "cancel", holdAssignment: true }, { type: "notify_cancel" });
  }
  return planOf({ type: "cancel", holdAssignment: false }, ...releaseEffects(session));
}

function planTimeout(session: SessionRecord, ctx: SessionTransitionContext): SessionTransitionPlan {
  if (session.status !== "running" || !session.ackReceivedAt) {
    return planOf({ type: "ignore", reason: "not_due" });
  }
  return planOf(
    ...releaseEffects(session),
    {
      type: "finish",
      status: "timed_out",
      completedAt: ctx.now,
      errorMessage: "session exceeded timeout without a host terminal report",
    },
    { type: "notify_cancel" },
    { type: "archive" },
  );
}

function planDisconnect(
  session: SessionRecord,
  event: Extract<SessionTransitionEvent, { type: "disconnect" }>,
  ctx: SessionTransitionContext,
): SessionTransitionPlan {
  if (session.status === "cancelled") return planOf(...releaseEffects(session));
  if (session.status !== "running") return planOf({ type: "ignore", reason: "not_running" });
  if (event.acknowledged) {
    return planOf({
      type: "mark_reconnect",
      deadlineAt: new Date(Date.parse(ctx.now) + (ctx.reconnectGraceMs ?? 0)).toISOString(),
    });
  }
  return planOf(...releaseEffects(session), {
    type: "requeue",
    reason: "disconnect",
    errorMessage: "host disconnected; requeued",
  });
}

function planQueueExpired(
  session: SessionRecord,
  ctx: SessionTransitionContext,
): SessionTransitionPlan {
  if (session.status !== "queued") return planOf({ type: "ignore", reason: "not_queued" });
  if (Date.parse(session.queueExpiresAt) > Date.parse(ctx.now)) {
    return planOf({ type: "ignore", reason: "not_due" });
  }
  return planOf(
    {
      type: "finish",
      status: "failed",
      completedAt: ctx.now,
      errorCode: "queue_expired",
      errorMessage: "queue TTL expired before capacity became available",
    },
    { type: "archive" },
  );
}

/** Pure session-transition policy. Callers commit the returned effects. */
export function planSessionTransition(
  session: SessionRecord | null,
  event: SessionTransitionEvent,
  ctx: SessionTransitionContext,
): SessionTransitionPlan {
  if (!session) return planOf({ type: "reject", error: "session not found" });
  switch (event.type) {
    case "ack":
      return planAck(session, event);
    case "command_start":
      return planCommandStart(session, event);
    case "status":
      return planStatus(session, event, ctx);
    case "cancel":
      return planCancel(session);
    case "timeout":
      return planTimeout(session, ctx);
    case "disconnect":
      return planDisconnect(session, event, ctx);
    case "infrastructure_failure":
      return planInfrastructureFailure(session, event.code, ctx);
    case "queue_expired":
      return planQueueExpired(session, ctx);
    case "log":
      return planAttemptId(session, event.attemptId);
    case "reconnect_claim":
      return planAttemptId(session, event.attemptId, true);
  }
}
