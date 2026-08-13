/* eslint-disable max-lines -- snapshot variants and lifecycle reconciliation share fixtures. */
import { describe, expect, it } from "vitest";

import type { SessionRecord } from "./db/types.ts";
import type { SlackDeliveryRecord, SlackOutboxStore } from "./slack-delivery-types.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-integration-types.ts";
import { reconcileSlackSession, slackSessionSnapshot } from "./slack-session-runtime.ts";

const now = "2026-08-12T10:00:00.000Z";

class InsertStore implements Pick<SlackOutboxStore, "enqueue"> {
  readonly items = new Map<string, SlackDeliveryRecord>();

  async enqueue(record: SlackDeliveryRecord) {
    if (this.items.has(record.id)) return "exists" as const;
    this.items.set(record.id, structuredClone(record));
    return "created" as const;
  }
}

function session(status: SessionRecord["status"] = "queued"): SessionRecord {
  return {
    id: "session-1",
    repositoryId: "repo-1",
    prompt: "ship it",
    target: { commandId: "command-1" },
    fallbacks: [],
    targetLabels: ["Codex", "Claude"],
    queueTtlSeconds: 60,
    queueExpiresAt: now,
    timeout: 60,
    priority: 4,
    requiredLabels: [],
    status,
    queueShard: 0,
    createdAt: now,
    source: "ui",
  };
}

function state() {
  return {
    repositories: new Map([
      [
        "repo-1",
        {
          id: "repo-1",
          name: "auto-harness",
          url: "git@example.test:auto-harness.git",
          defaultBranch: "main",
          createdAt: now,
          updatedAt: now,
        },
      ],
    ]),
    logs: new Map([
      [
        "session-1",
        [
          { stream: "stdout", content: "ignored" },
          { stream: "stderr", content: "one\ntwo\n" },
          { stream: "stderr", content: "three\nfour\nfive\nsix" },
        ],
      ],
    ]),
    publicBaseUrl: "https://harness.example.test",
  } as never;
}

const config = {
  enabled: true,
  defaultChannel: "C123",
  notifications: DEFAULT_SLACK_NOTIFICATIONS,
};

describe("Slack session lifecycle reconciliation", () => {
  it("derives a bounded delivery snapshot from control-plane state", () => {
    const record = {
      ...session("failed"),
      metadata: { sourceActor: " Ada " },
      resolvedRoute: {
        targetIndex: 1,
        providerAccountId: "account-1",
        commandId: "command-2",
        hostId: "host-1",
        worktreeId: "wt-1",
        attemptId: "attempt-1",
      },
      startedAt: now,
      completedAt: now,
      hostId: "host-1",
      worktreeId: "wt-1",
      exitCode: 1,
      errorCode: "boom",
      errorMessage: "failed",
    } satisfies SessionRecord;
    expect(slackSessionSnapshot(state(), record)).toMatchObject({
      repositoryName: "auto-harness",
      commandLabel: "Claude",
      sourceActor: "Ada",
      stderrTail: ["two", "three", "four", "five", "six"],
      url: "https://harness.example.test/sessions/session-1",
      exitCode: 1,
    });

    const fallback = session();
    fallback.repositoryId = "missing";
    fallback.targetLabels = [];
    fallback.source = undefined;
    fallback.metadata = { sourceActor: " " };
    expect(slackSessionSnapshot({ ...state(), logs: new Map() }, fallback)).toMatchObject({
      repositoryName: "missing",
      commandLabel: "Unknown",
      source: "api",
    });
  });

  it("reconciles queued, running, and terminal operations idempotently", async () => {
    const store = new InsertStore();
    const queued = slackSessionSnapshot(state(), session());
    expect(
      await reconcileSlackSession({
        store: store as SlackOutboxStore,
        config,
        session: queued,
        now,
      }),
    ).toEqual({
      created: 1,
      existing: 0,
    });

    const running = { ...queued, status: "running" as const, startedAt: now };
    expect(
      await reconcileSlackSession({
        store: store as SlackOutboxStore,
        config,
        session: running,
        now,
      }),
    ).toEqual({
      created: 1,
      existing: 2,
    });

    const completed = { ...running, status: "completed" as const, completedAt: now, exitCode: 0 };
    expect(
      await reconcileSlackSession({
        store: store as SlackOutboxStore,
        config,
        session: completed,
        now,
      }),
    ).toEqual({
      created: 2,
      existing: 4,
    });
    expect(
      await reconcileSlackSession({
        store: store as SlackOutboxStore,
        config,
        session: completed,
        now,
      }),
    ).toEqual({
      created: 0,
      existing: 6,
    });
    expect([...store.items.values()].map(({ operation }) => operation)).toEqual([
      "post-root",
      "post-reply",
      "post-reply",
      "update-root",
    ]);
  });

  it("maps every terminal state and ignores unavailable integrations", async () => {
    for (const status of ["failed", "timed_out", "cancelled"] as const) {
      const store = new InsertStore();
      await reconcileSlackSession({
        store: store as SlackOutboxStore,
        config,
        session: { ...slackSessionSnapshot(state(), session(status)), completedAt: now },
        now,
      });
      expect([...store.items.keys()]).toContain(
        `slack:session-1:${status === "cancelled" ? "session_cancelled" : "session_failed"}:reply`,
      );
      expect([...store.items.keys()]).not.toContain("slack:session-1:session_started:reply");
    }
    const store = new InsertStore();
    const snapshot = slackSessionSnapshot(state(), session());
    await expect(
      reconcileSlackSession({
        store: store as SlackOutboxStore,
        config: null,
        session: snapshot,
        now,
      }),
    ).resolves.toEqual({ created: 0, existing: 0 });
    await expect(
      reconcileSlackSession({
        store: store as SlackOutboxStore,
        config: { ...config, enabled: false },
        session: snapshot,
        now,
      }),
    ).resolves.toEqual({ created: 0, existing: 0 });
  });
});
