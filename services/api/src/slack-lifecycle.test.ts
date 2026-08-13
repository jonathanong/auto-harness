/* eslint-disable max-lines -- lifecycle planning and formatting variants share one fixture. */
import { describe, expect, it } from "vitest";

import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-integration-types.ts";
import { planSlackLifecycle, slackLifecycleEvent } from "./slack-lifecycle.ts";
import { formatSlackFinalRoot, formatSlackLifecycleMessage } from "./slack-message-format.ts";
import type { SlackSessionSnapshot } from "./slack-delivery-types.ts";

const base: SlackSessionSnapshot = {
  id: "session-1",
  repositoryName: "auto-harness",
  prompt: "ship it",
  commandLabel: "Codex",
  priority: 4,
  source: "ui",
  sourceActor: "Ada",
  url: "https://example.test/sessions/session-1",
  status: "queued",
  createdAt: "2026-08-12T10:00:00.000Z",
};

describe("Slack lifecycle planning", () => {
  it("maps relevant status transitions and ignores duplicates", () => {
    expect(slackLifecycleEvent(undefined, "queued")).toBe("session_created");
    expect(slackLifecycleEvent("queued", "queued")).toBeNull();
    expect(slackLifecycleEvent("queued", "running")).toBe("session_started");
    expect(slackLifecycleEvent("running", "completed")).toBe("session_completed");
    expect(slackLifecycleEvent("running", "cancelled")).toBe("session_cancelled");
    expect(slackLifecycleEvent("running", "failed")).toBe("session_failed");
    expect(slackLifecycleEvent("running", "timed_out")).toBe("session_failed");
    expect(slackLifecycleEvent("running", "queued")).toBeNull();
  });

  it("plans stable ordered root, reply, and terminal update IDs", () => {
    const created = planSlackLifecycle({
      event: "session_created",
      session: base,
      channel: "C123",
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      now: base.createdAt,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ id: "slack:session-1:thread", maxAttempts: 8 });

    const started = planSlackLifecycle({
      event: "session_started",
      session: { ...base, status: "running" },
      channel: "C123",
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      now: base.createdAt,
      maxAttempts: 3,
    });
    expect(started.map(({ id }) => id)).toEqual([
      "slack:session-1:thread",
      "slack:session-1:session_started:reply",
    ]);
    expect(started[1]).toMatchObject({ dependsOnId: started[0].id, maxAttempts: 3 });

    const completed = planSlackLifecycle({
      event: "session_completed",
      session: { ...base, status: "completed" },
      channel: "C123",
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      now: base.createdAt,
    });
    expect(completed.map(({ operation }) => operation)).toEqual([
      "post-root",
      "post-reply",
      "update-root",
    ]);
    expect(completed[2].dependsOnId).toBe(completed[1].id);
  });

  it("honors every notification flag", () => {
    for (const event of [
      "session_created",
      "session_started",
      "session_completed",
      "session_failed",
      "session_cancelled",
    ] as const) {
      expect(
        planSlackLifecycle({
          event,
          session: base,
          channel: "C123",
          notifications: {
            ...DEFAULT_SLACK_NOTIFICATIONS,
            onSessionCreated: false,
            onSessionStarted: false,
            onSessionCompleted: false,
            onSessionFailed: false,
            onSessionCancelled: false,
          },
          now: base.createdAt,
        }),
      ).toEqual([]);
    }

    const withoutCreated = {
      ...DEFAULT_SLACK_NOTIFICATIONS,
      onSessionCreated: false,
    };
    const started = planSlackLifecycle({
      event: "session_started",
      session: { ...base, status: "running" },
      channel: "C123",
      notifications: withoutCreated,
      now: base.createdAt,
    });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ event: "session_started", operation: "post-root" });
    expect(started[0].text).toContain("Session started");

    const terminalOnly = planSlackLifecycle({
      event: "session_failed",
      session: { ...base, status: "failed" },
      channel: "C123",
      notifications: { ...withoutCreated, onSessionStarted: false },
      now: base.createdAt,
    });
    expect(terminalOnly).toHaveLength(1);
    expect(terminalOnly[0]).toMatchObject({ event: "session_failed", operation: "post-root" });
    expect(terminalOnly[0].text).toContain("Session failed");

    const startedThenTerminal = planSlackLifecycle({
      event: "session_completed",
      session: { ...base, status: "completed", startedAt: base.createdAt },
      channel: "C123",
      notifications: withoutCreated,
      now: base.createdAt,
    });
    expect(startedThenTerminal.map(({ event, operation }) => ({ event, operation }))).toEqual([
      { event: "session_started", operation: "post-root" },
      { event: "session_completed", operation: "post-reply" },
      { event: "session_completed", operation: "update-root" },
    ]);
  });
});

describe("Slack message formatting", () => {
  it("formats queued and running messages without unbounded newlines", () => {
    const queued = formatSlackLifecycleMessage("session_created", {
      ...base,
      prompt: `${"x".repeat(510)}\nsecret`,
    });
    expect(queued).toContain("📋 Session queued");
    expect(queued).not.toContain("\nsecret");
    expect(
      formatSlackLifecycleMessage("session_created", { ...base, sourceActor: undefined }),
    ).toContain("Source: ui\n");
    expect(formatSlackLifecycleMessage("session_started", base)).toContain("Agent: —");
    expect(
      formatSlackLifecycleMessage("session_started", {
        ...base,
        hostId: "host-1",
        worktreeId: "wt-1",
      }),
    ).toContain("Worktree: wt-1");
  });

  it("formats terminal variants, bounded errors, and only five stderr lines", () => {
    const completed = { ...base, status: "completed" as const, exitCode: null };
    expect(formatSlackLifecycleMessage("session_completed", completed)).toContain("Exit code: 0");
    expect(formatSlackLifecycleMessage("session_cancelled", base)).toContain("(Ada)");
    const failed = formatSlackLifecycleMessage("session_failed", {
      ...base,
      status: "failed",
      exitCode: 1,
      errorMessage: "e".repeat(510),
      stderrTail: ["1", "2", "3", "4", "5", "6".repeat(310)],
    });
    expect(failed).not.toContain("> 1");
    expect(failed).toContain("Last 5 lines of stderr:");
    expect(failed).toContain("…");
    expect(
      formatSlackLifecycleMessage("session_failed", { ...base, status: "timed_out" }),
    ).toContain("timed out");
    expect(
      formatSlackLifecycleMessage("session_failed", {
        ...base,
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).toContain("usage limit");
  });

  it("formats duration only for valid chronological terminal timestamps", () => {
    expect(
      formatSlackFinalRoot({
        ...base,
        sourceActor: undefined,
        status: "completed",
        startedAt: "2026-08-12T10:00:00.000Z",
        completedAt: "2026-08-12T10:02:03.000Z",
        exitCode: 0,
      }),
    ).toContain("in 2m 3s");
    expect(
      formatSlackFinalRoot({ ...base, status: "cancelled", completedAt: "invalid" }),
    ).not.toContain(" in ");
    expect(
      formatSlackFinalRoot({
        ...base,
        status: "failed",
        exitCode: null,
        createdAt: "invalid",
        completedAt: "2026-08-12T10:00:00.000Z",
      }),
    ).toContain("Exit code: —");
    expect(
      formatSlackFinalRoot({
        ...base,
        status: "failed",
        completedAt: "2026-08-12T09:00:00.000Z",
      }),
    ).not.toContain(" in ");
  });
});
