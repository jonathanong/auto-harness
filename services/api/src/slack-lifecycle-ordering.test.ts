import { describe, expect, it } from "vitest";

import type {
  SlackDeliveryRecord,
  SlackOutboxStore,
  SlackSessionSnapshot,
} from "./slack-delivery-types.ts";
import { DEFAULT_SLACK_NOTIFICATIONS } from "./slack-integration-types.ts";
import { planSlackLifecycle } from "./slack-lifecycle.ts";
import { processSlackOutboxOnce } from "./slack-outbox.ts";
import { reconcileSlackSession } from "./slack-session-runtime.ts";

const now = "2026-09-19T06:45:00.000Z";

const base: SlackSessionSnapshot = {
  id: "sess-b2ab689d",
  repositoryName: "auto-harness",
  prompt: "ship it",
  commandLabel: "Codex",
  priority: 4,
  source: "ui",
  url: "https://example.test/sessions/sess-b2ab689d",
  status: "queued",
  createdAt: now,
};

class MemoryStore implements SlackOutboxStore {
  readonly items = new Map<string, SlackDeliveryRecord>();

  async enqueue(value: SlackDeliveryRecord) {
    if (this.items.has(value.id)) return "exists" as const;
    this.items.set(value.id, structuredClone(value));
    return "created" as const;
  }

  async get(id: string) {
    return structuredClone(this.items.get(id) ?? null);
  }

  async claimDue(input: Parameters<SlackOutboxStore["claimDue"]>[0]) {
    const value = [...this.items.values()].find(
      (item) =>
        (item.status === "pending" || item.status === "delivering") &&
        item.nextAttemptAt <= input.now,
    );
    if (!value) return null;
    Object.assign(value, {
      status: "delivering",
      leaseToken: input.leaseToken,
      leaseExpiresAt: input.leaseExpiresAt,
      nextAttemptAt: input.leaseExpiresAt,
    });
    return structuredClone(value);
  }

  async complete(input: Parameters<SlackOutboxStore["complete"]>[0]) {
    const value = this.items.get(input.id);
    if (!value || value.leaseToken !== input.leaseToken) return false;
    Object.assign(value, {
      status: "sent",
      remoteChannel: input.result.channel,
      remoteMessageTs: input.result.messageTs,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return true;
  }

  async reschedule(input: Parameters<SlackOutboxStore["reschedule"]>[0]) {
    const value = this.items.get(input.id);
    if (!value || value.leaseToken !== input.leaseToken) return false;
    Object.assign(value, input, {
      lastError: input.error,
      leaseToken: undefined,
      leaseExpiresAt: undefined,
    });
    return true;
  }
}

const config = {
  enabled: true,
  defaultChannel: "C123",
  notifications: DEFAULT_SLACK_NOTIFICATIONS,
};

describe("Slack lifecycle reply ordering (enqueue-time policy)", () => {
  it("chains a terminal reply to an existing started reply instead of the thread root", async () => {
    const plan = await planSlackLifecycle({
      event: "session_completed",
      session: { ...base, status: "completed", startedAt: now },
      channel: "C123",
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      now,
      getDelivery: async (id) =>
        id === "slack:sess-b2ab689d:session_started:reply"
          ? ({ status: "pending" } as SlackDeliveryRecord)
          : null,
    });
    const reply = plan.find((item) => item.operation === "post-reply")!;
    expect(reply.dependsOnId).toBe("slack:sess-b2ab689d:session_started:reply");
    expect(reply.threadRootId).toBe("slack:sess-b2ab689d:thread");
  });

  it("falls back to the thread root when the started reply was never created", async () => {
    const neverAsked = await planSlackLifecycle({
      event: "session_cancelled",
      session: { ...base, status: "cancelled" },
      channel: "C123",
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      now,
      getDelivery: async () => null,
    });
    expect(neverAsked.find((item) => item.operation === "post-reply")?.dependsOnId).toBe(
      "slack:sess-b2ab689d:thread",
    );

    const disabledStarted = await planSlackLifecycle({
      event: "session_completed",
      session: { ...base, status: "completed", startedAt: now },
      channel: "C123",
      notifications: { ...DEFAULT_SLACK_NOTIFICATIONS, onSessionStarted: false },
      now,
      getDelivery: async () => null,
    });
    expect(disabledStarted.find((item) => item.operation === "post-reply")?.dependsOnId).toBe(
      "slack:sess-b2ab689d:thread",
    );
  });

  it("falls back to the thread root when no lookup is supplied at all", async () => {
    const plan = await planSlackLifecycle({
      event: "session_completed",
      session: { ...base, status: "completed", startedAt: now },
      channel: "C123",
      notifications: DEFAULT_SLACK_NOTIFICATIONS,
      now,
    });
    expect(plan.find((item) => item.operation === "post-reply")?.dependsOnId).toBe(
      "slack:sess-b2ab689d:thread",
    );
  });
});

describe("Slack lifecycle reply ordering (production interleaving)", () => {
  it("posts started before completed even when the root was delayed and completed became due first", async () => {
    const store = new MemoryStore();
    const rootId = "slack:sess-b2ab689d:thread";
    const startedReplyId = "slack:sess-b2ab689d:session_started:reply";
    const completedReplyId = "slack:sess-b2ab689d:session_completed:reply";
    const updateId = "slack:sess-b2ab689d:session_completed:update";

    // The root ("not_in_channel" retries) is still pending when both later events reconcile.
    await reconcileSlackSession({ store, config, session: base, now });
    const running = { ...base, status: "running" as const, startedAt: now };
    await reconcileSlackSession({ store, config, session: running, now });
    const completed = { ...running, status: "completed" as const, completedAt: now, exitCode: 0 };
    await reconcileSlackSession({ store, config, session: completed, now });
    expect(store.items.get(completedReplyId)?.dependsOnId).toBe(startedReplyId);

    // Simulate the production race: reorder the durable rows so a naive "first due" scan
    // would offer the completed reply before the started reply. The fix must make the
    // final delivery order depend on `dependsOnId`, not on this happenstance ordering.
    const byId = new Map(store.items);
    store.items.clear();
    for (const id of [rootId, completedReplyId, startedReplyId, updateId]) {
      store.items.set(id, byId.get(id)!);
    }

    const posted: string[] = [];
    const transport = {
      async deliver(request: { idempotencyKey: string; channel: string }) {
        posted.push(request.idempotencyKey);
        return { channel: request.channel, messageTs: `ts-${request.idempotencyKey}` };
      },
    };
    // Model the real worker: one tick holds the clock still (so a deferred dependency
    // does not spuriously become due again mid-tick) and drains until idle; only the
    // *next* tick, once the dependency delay has actually elapsed, advances the clock.
    let clockMs = Date.parse(now);
    let leases = 0;
    for (let tick = 0; tick < 5 && posted.length < 4; tick += 1) {
      const tickNow = new Date(clockMs).toISOString();
      const options = { now: () => tickNow, leaseToken: () => `lease-${(leases += 1)}` };
      for (let i = 0; i < 10; i += 1) {
        if ((await processSlackOutboxOnce(store, transport, options)) === "idle") break;
      }
      clockMs += 2000;
    }

    expect(posted).toEqual([rootId, startedReplyId, completedReplyId, updateId]);
  });
});
