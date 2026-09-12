import { describe, expect, it, vi } from "vitest";

import type { SessionRecord } from "./db/types.ts";
import type { WebhookOutboxStore } from "./webhook-delivery-types.ts";
import { reconcileWebhookSession, webhookLifecycleSnapshot } from "./webhook-lifecycle.ts";
import { createWebhookDelivery } from "./webhook-outbox.ts";

const occurredAt = "2026-08-15T12:00:00.000Z";

function session(
  status: SessionRecord["status"],
  fields: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    id: `session-${status}`,
    repositoryId: "repository-1",
    prompt: "must not reach destination selection",
    target: { commandId: "command-1" },
    fallbacks: [],
    targetDisplayNames: ["Codex"],
    queueTtlSeconds: 60,
    queueExpiresAt: occurredAt,
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status,
    queueShard: 0,
    createdAt: occurredAt,
    completedAt: occurredAt,
    ...fields,
  };
}

function store(): WebhookOutboxStore & {
  rows: Map<string, ReturnType<typeof createWebhookDelivery>>;
} {
  const rows = new Map<string, ReturnType<typeof createWebhookDelivery>>();
  return {
    rows,
    async enqueueWebhookDelivery(input) {
      const delivery = createWebhookDelivery(input);
      const existing = rows.get(delivery.id);
      if (existing) return { created: false, delivery: existing };
      rows.set(delivery.id, delivery);
      return { created: true, delivery };
    },
    listDueWebhookDeliveries: vi.fn(),
    claimWebhookDelivery: vi.fn(),
    completeWebhookDelivery: vi.fn(),
    failWebhookDelivery: vi.fn(),
    deadLetterExhaustedWebhookDelivery: vi.fn(),
  };
}

describe("webhook lifecycle reconciliation", () => {
  it("builds secret-safe snapshots for every terminal status, including unassigned sessions", () => {
    for (const status of ["completed", "failed", "timed_out", "cancelled"] as const) {
      expect(webhookLifecycleSnapshot(session(status))).toEqual({
        sessionId: `session-${status}`,
        repositoryId: "repository-1",
        workspacePoolId: null,
        workspaceSlotId: null,
        attemptId: null,
        status,
        occurredAt,
      });
    }
    expect(
      webhookLifecycleSnapshot(session("completed", { attemptId: "attempt-1" })),
    ).toMatchObject({ attemptId: "attempt-1" });
    expect(
      webhookLifecycleSnapshot(
        session("completed", {
          repositoryId: "",
          workspacePoolId: "workspace-pool-1",
          workspaceSlotId: null,
          resolvedRoute: {
            targetIndex: 0,
            commandId: "command-1",
            hostId: "host-1",
            worktreeId: null,
            workspacePoolId: "workspace-pool-1",
            workspaceSlotId: "workspace-slot-1",
            attemptId: "attempt-1",
          },
        }),
      ),
    ).toMatchObject({
      repositoryId: null,
      workspacePoolId: "workspace-pool-1",
      workspaceSlotId: "workspace-slot-1",
    });
    expect(webhookLifecycleSnapshot(session("running"))).toBeNull();
    expect(webhookLifecycleSnapshot(session("cancelled", { completedAt: undefined }))).toBeNull();
  });

  it("selects immutable versions and deduplicates replay without exposing session content", async () => {
    const outbox = store();
    const selectDestinations = vi.fn(async () => [
      { configurationId: "operations", configurationVersion: 3 },
      { configurationId: "audit", configurationVersion: 1 },
    ]);
    const completed = session("completed", { attemptId: "attempt-1" });

    await expect(
      reconcileWebhookSession({ store: outbox, selectDestinations, session: completed }),
    ).resolves.toEqual({ created: 2, existing: 0 });
    await expect(
      reconcileWebhookSession({ store: outbox, selectDestinations, session: completed }),
    ).resolves.toEqual({ created: 0, existing: 2 });
    expect(selectDestinations).toHaveBeenCalledWith({
      sessionId: completed.id,
      repositoryId: completed.repositoryId,
      workspacePoolId: null,
      workspaceSlotId: null,
      attemptId: completed.attemptId,
      status: completed.status,
      occurredAt,
    });
    expect(JSON.stringify(selectDestinations.mock.calls)).not.toContain(completed.prompt);
    expect([...outbox.rows.values()].map(({ destination }) => destination)).toEqual([
      { configurationId: "operations", configurationVersion: 3 },
      { configurationId: "audit", configurationVersion: 1 },
    ]);
  });

  it("does not invoke destination selection for nonterminal snapshots", async () => {
    const selectDestinations = vi.fn();
    await expect(
      reconcileWebhookSession({ store: store(), selectDestinations, session: session("queued") }),
    ).resolves.toEqual({ created: 0, existing: 0 });
    expect(selectDestinations).not.toHaveBeenCalled();
  });

  it("reconciles a terminal workspace session without inventing a repository", async () => {
    const outbox = store();
    const selectDestinations = vi.fn(async () => [
      { configurationId: "operations", configurationVersion: 3 },
    ]);
    const completed = session("completed", {
      id: "workspace-session",
      repositoryId: "",
      workspacePoolId: "workspace-pool-1",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "command-1",
        hostId: "host-1",
        worktreeId: null,
        workspacePoolId: "workspace-pool-1",
        workspaceSlotId: "workspace-slot-1",
        attemptId: "attempt-1",
      },
    });

    await expect(
      reconcileWebhookSession({ store: outbox, selectDestinations, session: completed }),
    ).resolves.toEqual({ created: 1, existing: 0 });
    expect(selectDestinations).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: null,
        workspacePoolId: "workspace-pool-1",
        workspaceSlotId: "workspace-slot-1",
      }),
    );
    expect([...outbox.rows.values()][0]?.event.data).toMatchObject({
      repositoryId: null,
      workspacePoolId: "workspace-pool-1",
      workspaceSlotId: "workspace-slot-1",
    });
  });
});
