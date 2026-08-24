/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  finishSessionOptsFromPlan,
  requeueUsageLimitedSessionOptsFromPlan,
  suppressProviderlessUsageLimitOptsFromPlan,
} from "./db/plane-storage-sessions.ts";
import type { SessionRecord } from "./db/types.ts";
import {
  planSessionTransition,
  transitionEffect,
  type SessionTransitionContext,
  type SessionTransitionEvent,
  type SessionTransitionPlan,
} from "./session-transition-planner.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T05:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "prompt",
    source: "api",
    hostId: "host",
    worktreeId: "wt",
    attemptId: "attempt",
    resolvedRoute: {
      targetIndex: 0,
      commandId: "cmd",
      hostId: "host",
      worktreeId: "wt",
      attemptId: "attempt",
    },
    ...over,
  };
}

function ctx(over: Partial<SessionTransitionContext> = {}): SessionTransitionContext {
  return { now: NOW, source: "durable", usageLimitRetryCeiling: 3, ...over };
}

function types(event: SessionTransitionEvent, row: SessionRecord = session(), extra = ctx()) {
  return planSessionTransition(row, event, extra).effects.map((effect) => effect.type);
}

const status = (
  over: Partial<Extract<SessionTransitionEvent, { type: "status" }>> = {},
): Extract<SessionTransitionEvent, { type: "status" }> => ({
  type: "status",
  worktreeId: "wt",
  attemptId: "attempt",
  status: "completed",
  ...over,
});

describe("session-transition planner", () => {
  it("rejects a missing session", () => {
    expect(planSessionTransition(null, { type: "cancel" }, ctx()).effects).toEqual([
      { type: "reject", error: "session not found" },
    ]);
  });

  it("locks ordinary success and ordinary failure effect lists", () => {
    expect(types(status())).toEqual(["release_worktree", "finish", "archive"]);
    expect(
      transitionEffect(planSessionTransition(session(), status(), ctx()), "finish"),
    ).toMatchObject({
      status: "completed",
      completedAt: NOW,
    });
    expect(
      types(status({ status: "failed", errorCode: "setup_failed", errorMessage: "boom" })),
    ).toEqual(["release_worktree", "finish", "archive"]);
    expect(
      transitionEffect(
        planSessionTransition(
          session(),
          status({ status: "failed", errorCode: "setup_failed", errorMessage: "boom" }),
          ctx(),
        ),
        "finish",
      ),
    ).toMatchObject({ status: "failed", errorCode: "setup_failed", errorMessage: "boom" });
  });

  it("usage_limit with fallback remaining cools the account and advances", () => {
    const row = session({
      fallbacks: [{ commandId: "fallback" }],
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "acct",
        hostId: "host",
        worktreeId: "wt",
        attemptId: "attempt",
      },
    });
    const plan = planSessionTransition(
      row,
      status({ status: "failed", errorCode: "usage_limit", errorMessage: "quota" }),
      ctx({ providerAccount: { usageLimitCooldownSeconds: 18_000 } }),
    );
    expect(plan.effects.map((effect) => effect.type)).toEqual([
      "cooldown",
      "release_worktree",
      "fallback",
      "requeue",
      "reschedule",
    ]);
    expect(transitionEffect(plan, "cooldown")).toEqual({
      type: "cooldown",
      providerAccountId: "acct",
      usageLimitedUntil: LATER,
    });
    expect(transitionEffect(plan, "requeue")).toMatchObject({
      reason: "usage_limit",
      errorCode: "usage_limit",
    });
    expect(transitionEffect(plan, "reschedule")).toEqual({ type: "reschedule", kind: "prompt" });
  });

  it("usage_limit with no fallback stays queued until the original deadline", () => {
    const plan = planSessionTransition(
      session({
        resolvedRoute: {
          targetIndex: 0,
          commandId: "cmd",
          providerAccountId: "acct",
          hostId: "host",
          worktreeId: "wt",
          attemptId: "attempt",
        },
      }),
      status({ status: "failed", errorCode: "usage_limit" }),
      ctx({ providerAccount: { usageLimitCooldownSeconds: 18_000 } }),
    );
    expect(plan.effects.map((effect) => effect.type)).toEqual([
      "cooldown",
      "release_worktree",
      "requeue",
      "reschedule",
    ]);
    expect(transitionEffect(plan, "fallback")).toBeUndefined();
    expect(transitionEffect(plan, "finish")).toBeUndefined();
    expect(transitionEffect(plan, "requeue")).toMatchObject({
      reason: "usage_limit",
      errorCode: "usage_limit",
    });
  });

  it("providerless usage_limit suppresses the current target", () => {
    const plan = planSessionTransition(
      session({ fallbacks: [{ commandId: "fallback" }] }),
      status({ status: "failed", errorCode: "usage_limit" }),
      ctx(),
    );
    expect(plan.effects.map((effect) => effect.type)).toEqual([
      "suppress_target",
      "release_worktree",
      "fallback",
      "requeue",
      "reschedule",
    ]);
    expect(transitionEffect(plan, "suppress_target")).toEqual({
      type: "suppress_target",
      targetIndex: 0,
    });
    expect(transitionEffect(plan, "cooldown")).toBeUndefined();
    expect(transitionEffect(plan, "requeue")).toMatchObject({ reason: "providerless" });
  });

  it("ignores a stale attempt", () => {
    expect(
      planSessionTransition(session(), status({ worktreeId: "other", attemptId: "old" }), ctx())
        .effects,
    ).toEqual([{ type: "ignore", reason: "stale_attempt" }]);
    expect(
      planSessionTransition(
        session({ ackReceivedAt: NOW }),
        { type: "ack", worktreeId: "wt", attemptId: "attempt" },
        ctx(),
      ).effects,
    ).toEqual([{ type: "ignore", reason: "already_acked" }]);
  });

  it("cancels running work in place and queued work with a release", () => {
    expect(types({ type: "cancel" })).toEqual(["cancel", "notify_cancel"]);
    expect(
      transitionEffect(planSessionTransition(session(), { type: "cancel" }, ctx()), "cancel"),
    ).toEqual({
      type: "cancel",
      holdAssignment: true,
    });
    expect(
      types({ type: "cancel" }, session({ status: "queued", hostId: null, worktreeId: "wt" })),
    ).toEqual(["cancel", "release_worktree"]);
    expect(
      planSessionTransition(session({ status: "completed" }), { type: "cancel" }, ctx()).effects,
    ).toEqual([{ type: "reject", error: "session already terminal: completed" }]);
  });

  it("fails queue_expired when the original deadline has passed", () => {
    const plan = planSessionTransition(
      session({ status: "queued", hostId: null, worktreeId: null, queueExpiresAt: NOW }),
      { type: "queue_expired" },
      ctx(),
    );
    expect(plan.effects.map((effect) => effect.type)).toEqual(["finish", "archive"]);
    expect(transitionEffect(plan, "finish")).toMatchObject({
      status: "failed",
      errorCode: "queue_expired",
      errorMessage: "queue TTL expired before capacity became available",
    });
    expect(
      planSessionTransition(
        session({ status: "queued", queueExpiresAt: "2026-01-02T00:00:00.000Z" }),
        { type: "queue_expired" },
        ctx(),
      ).effects,
    ).toEqual([{ type: "ignore", reason: "not_due" }]);
  });

  it("covers ack, timeout, disconnect, and leased usage-limit variants", () => {
    expect(types({ type: "ack", worktreeId: "wt", attemptId: "attempt" })).toEqual(["ack"]);
    expect(types({ type: "timeout" }, session({ ackReceivedAt: NOW }))).toEqual([
      "release_worktree",
      "finish",
      "notify_cancel",
      "archive",
    ]);
    expect(planSessionTransition(session(), { type: "timeout" }, ctx()).effects).toEqual([
      { type: "ignore", reason: "not_due" },
    ]);
    expect(
      types(
        { type: "disconnect", acknowledged: true },
        session({ ackReceivedAt: NOW }),
        ctx({ reconnectGraceMs: 5_000 }),
      ),
    ).toEqual(["mark_reconnect"]);
    expect(types({ type: "disconnect", acknowledged: false })).toEqual([
      "release_worktree",
      "requeue",
    ]);
    expect(
      types({ type: "disconnect", acknowledged: false }, session({ status: "cancelled" })),
    ).toEqual(["release_worktree"]);
    expect(
      planSessionTransition(
        session({ status: "queued" }),
        { type: "disconnect", acknowledged: false },
        ctx(),
      ).effects,
    ).toEqual([{ type: "ignore", reason: "not_running" }]);
    expect(planSessionTransition(session(), { type: "queue_expired" }, ctx()).effects).toEqual([
      { type: "ignore", reason: "not_queued" },
    ]);

    const leased = session({
      type: "scheduled",
      mainCheckoutLease: true,
      worktreeId: null,
      assignmentConnectionId: "conn",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "acct",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
      },
    });
    expect(
      types(
        status({ worktreeId: null, status: "failed", errorCode: "usage_limit" }),
        leased,
        ctx({ providerAccount: { usageLimitCooldownSeconds: 60 } }),
      ),
    ).toEqual(["cooldown", "release_lease", "requeue", "reschedule"]);
    expect(
      types(
        status({ worktreeId: null, status: "failed", errorCode: "usage_limit" }),
        leased,
        ctx({ providerAccount: null }),
      ),
    ).toEqual(["release_lease", "requeue", "reschedule"]);
    expect(
      transitionEffect(
        planSessionTransition(
          leased,
          status({ worktreeId: null, status: "failed", errorCode: "usage_limit" }),
          ctx({ providerAccount: null }),
        ),
        "requeue",
      ),
    ).toMatchObject({ reason: "missing_account" });

    const providerlessLeased = session({
      type: "scheduled",
      mainCheckoutLease: true,
      worktreeId: null,
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        hostId: "host",
        worktreeId: null,
        attemptId: "attempt",
      },
    });
    expect(
      types(
        status({ worktreeId: null, status: "failed", errorCode: "usage_limit" }),
        providerlessLeased,
        ctx({ usageLimitRetryCeiling: 1 }),
      ),
    ).toEqual(["suppress_target", "release_lease", "requeue", "reschedule"]);
    expect(
      types(
        status({ worktreeId: null, status: "failed", errorCode: "usage_limit" }),
        { ...providerlessLeased, retryCount: 1, fallbacks: [{ commandId: "fallback" }] },
        ctx({ usageLimitRetryCeiling: 1 }),
      ),
    ).toEqual(["suppress_target", "release_lease", "fallback", "requeue", "reschedule"]);
  });

  it("covers local patches, durable ignores, and late cancelled releases", () => {
    expect(types(status({ status: "running" }), session(), ctx({ source: "local" }))).toEqual([
      "patch_report",
    ]);
    expect(planSessionTransition(session(), status({ status: "running" }), ctx()).effects).toEqual([
      { type: "ignore", reason: "non_terminal" },
    ]);
    expect(types(status(), session({ status: "completed" }), ctx({ source: "local" }))).toEqual([
      "release_worktree",
    ]);
    expect(types(status(), session({ status: "completed" }))).toEqual(["retry_archive", "ignore"]);
    expect(types(status({ cliResumeRef: "late" }), session({ status: "cancelled" }))).toEqual([
      "retry_archive",
      "release_worktree",
      "patch_report",
    ]);
    expect(
      types(
        status(),
        session({ status: "cancelled", worktreeId: null, mainCheckoutLease: undefined }),
      ),
    ).toEqual(["retry_archive", "ignore"]);
    expect(types(status({ worktreeId: "other" }), session({ status: "failed" }))).toEqual([
      "retry_archive",
      "ignore",
    ]);
    expect(
      planSessionTransition(session(), { type: "ack", worktreeId: "wt", attemptId: "old" }, ctx())
        .effects,
    ).toEqual([{ type: "ignore", reason: "stale_attempt" }]);
    expect(
      planSessionTransition(
        session({
          resolvedRoute: {
            targetIndex: 0,
            commandId: "cmd",
            providerAccountId: "acct",
            hostId: "host",
            worktreeId: "wt",
            attemptId: "attempt",
          },
        }),
        status({ status: "failed", errorCode: "usage_limit" }),
        ctx({ providerAccount: null }),
      ).effects,
    ).toEqual([{ type: "ignore", reason: "missing_account" }]);
    expect(
      types(
        status({ status: "failed", errorCode: "usage_limit" }),
        session({
          resolvedRoute: {
            targetIndex: 0,
            commandId: "cmd",
            providerAccountId: "acct",
            hostId: "host",
            worktreeId: "wt",
            attemptId: "attempt",
          },
        }),
        ctx({ source: "local", providerAccount: null }),
      ),
    ).toEqual(["release_worktree", "requeue", "reschedule"]);
    expect(
      types(
        status({ status: "completed", cliResumeRef: undefined }),
        session({ resumedFromSessionId: "prev", cliResumeRef: "old" }),
      ),
    ).toEqual(["release_worktree", "finish", "archive"]);
    expect(
      transitionEffect(
        planSessionTransition(
          session({ resumedFromSessionId: "prev", cliResumeRef: "old" }),
          status(),
          ctx(),
        ),
        "finish",
      )?.clearResumeRef,
    ).toBe(true);
    expect(types({ type: "cancel" }, session({ status: "running", hostId: null }))).toEqual([
      "cancel",
      "release_worktree",
    ]);
    expect(
      types(
        status({ status: "running" }),
        session({ status: "cancelled" }),
        ctx({ source: "local" }),
      ),
    ).toEqual(["patch_report"]);
    expect(
      types(
        status({ status: "running", cliResumeRef: "late" }),
        session({ status: "cancelled" }),
        ctx({ source: "local" }),
      ),
    ).toEqual(["patch_report"]);
    expect(
      types(
        status({ worktreeId: null, cliResumeRef: "late" }),
        session({ status: "cancelled", worktreeId: null, attemptId: "attempt" }),
      ),
    ).toEqual(["retry_archive", "ignore"]);
    expect(types(status({ status: "completed", exitCode: 0, cliResumeRef: "ref" }))).toEqual([
      "release_worktree",
      "finish",
      "archive",
    ]);
    expect(
      types(
        status({ status: "failed", errorCode: "usage_limit" }),
        session({ resolvedRoute: undefined, fallbacks: undefined as never }),
      ),
    ).toEqual(["suppress_target", "release_worktree", "requeue", "reschedule"]);
    expect(
      types(
        { type: "timeout" },
        session({ ackReceivedAt: NOW, worktreeId: null, mainCheckoutLease: true }),
      ),
    ).toEqual(["release_lease", "finish", "notify_cancel", "archive"]);
    expect(types({ type: "timeout" }, session({ ackReceivedAt: NOW, worktreeId: null }))).toEqual([
      "finish",
      "notify_cancel",
      "archive",
    ]);
    expect(
      types({ type: "disconnect", acknowledged: true }, session({ ackReceivedAt: NOW })),
    ).toEqual(["mark_reconnect"]);
  });

  it("maps planner effects onto storage writes", () => {
    const row = session({ concurrencyId: "lock" });
    const finishPlan: SessionTransitionPlan = {
      effects: [
        {
          type: "finish",
          status: "completed",
          completedAt: NOW,
          exitCode: 0,
          errorCode: "setup_failed",
          errorMessage: "boom",
          cliResumeRef: "ref",
        },
      ],
    };
    expect(
      finishSessionOptsFromPlan(row, finishPlan, {
        attemptId: "attempt",
        fence: { hostId: "host", connectionId: "conn" },
      }),
    ).toMatchObject({
      sessionId: "s",
      status: "completed",
      completedAt: NOW,
      exitCode: 0,
      errorCode: "setup_failed",
      errorMessage: "boom",
      cliResumeRef: "ref",
      fence: { hostId: "host", connectionId: "conn" },
      concurrencyId: "lock",
    });
    expect(
      finishSessionOptsFromPlan(
        row,
        { effects: [{ type: "finish", status: "completed", completedAt: NOW }] },
        { attemptId: "attempt" },
      ),
    ).toMatchObject({ status: "completed", completedAt: NOW });
    expect(
      finishSessionOptsFromPlan(
        row,
        { effects: [{ type: "requeue", reason: "providerless" }] },
        { attemptId: "attempt" },
      ),
    ).toMatchObject({ status: "queued" });
    expect(
      finishSessionOptsFromPlan(
        row,
        { effects: [{ type: "requeue", reason: "providerless" }] },
        { attemptId: "attempt" },
      ).completedAt,
    ).toBeUndefined();
    expect(
      finishSessionOptsFromPlan(
        row,
        {
          effects: [
            {
              type: "requeue",
              reason: "providerless",
              exitCode: 1,
              errorCode: "usage_limit",
              errorMessage: "limit",
              cliResumeRef: "r",
            },
          ],
        },
        { attemptId: "attempt" },
      ),
    ).toMatchObject({
      status: "queued",
      exitCode: 1,
      errorCode: "usage_limit",
      errorMessage: "limit",
      cliResumeRef: "r",
    });

    const cooldownPlan: SessionTransitionPlan = {
      effects: [
        { type: "cooldown", providerAccountId: "acct", usageLimitedUntil: LATER },
        { type: "requeue", reason: "usage_limit", errorMessage: "quota" },
      ],
    };
    expect(
      requeueUsageLimitedSessionOptsFromPlan(row, cooldownPlan, { now: NOW, attemptId: "attempt" }),
    ).toMatchObject({
      providerAccountId: "acct",
      usageLimitedUntil: LATER,
      errorMessage: "quota",
    });
    expect(
      requeueUsageLimitedSessionOptsFromPlan(
        row,
        { effects: [{ type: "cooldown", providerAccountId: "acct", usageLimitedUntil: LATER }] },
        { now: NOW, attemptId: "attempt" },
      ).errorMessage,
    ).toBeUndefined();

    const suppressPlan: SessionTransitionPlan = {
      effects: [
        { type: "suppress_target", targetIndex: 2 },
        { type: "requeue", reason: "providerless", errorMessage: "limit" },
      ],
    };
    expect(
      suppressProviderlessUsageLimitOptsFromPlan(row, suppressPlan, { attemptId: "attempt" }),
    ).toMatchObject({
      targetIndex: 2,
      errorMessage: "limit",
    });
    expect(
      suppressProviderlessUsageLimitOptsFromPlan(
        row,
        { effects: [{ type: "suppress_target", targetIndex: 0 }] },
        { attemptId: "attempt" },
      ).errorMessage,
    ).toBeUndefined();
  });
});
