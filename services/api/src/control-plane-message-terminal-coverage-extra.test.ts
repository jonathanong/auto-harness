import { describe, expect, it } from "vitest";

import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function row(over: Partial<SessionRecord> = {}): SessionRecord {
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
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    principalId: "system",
    hostId: "host",
    worktreeId: null,
    attemptId: "attempt",
    mainCheckoutLease: true,
    assignmentConnectionId: "connection",
    resolvedRoute: {
      targetIndex: 0,
      commandId: "cmd",
      providerAccountId: "account",
      hostId: "host",
      worktreeId: null,
      attemptId: "attempt",
    },
    ...over,
  };
}

const message = (extra: Record<string, unknown> = {}) => ({
  type: "session:status" as const,
  sessionId: "s",
  worktreeId: null,
  attemptId: "attempt",
  status: "failed" as const,
  errorCode: "usage_limit",
  ...extra,
});

describe("durable terminal message residual coverage", () => {
  it("releases a cancelled scheduled attempt with default completion metadata", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = row({
      status: "cancelled",
      errorCode: "cancelled",
      errorMessage: "cancelled by operator",
      cliResumeRef: "resume-existing",
    });
    state.sessions.set("s", session);
    let input: Record<string, unknown> = {};
    setDurableReadStorage(state, {
      releaseMainCheckoutSession: async (next: Record<string, unknown>) => {
        input = next;
        return true;
      },
    });
    await handleHostMessageDurable(state, message({ status: "completed", errorCode: undefined }));
    expect(input.completedAt).toBe(NOW);
    expect(state.sessions.get("s")?.mainCheckoutLease).toBeUndefined();
    expect(state.sessions.get("s")).toMatchObject({
      errorCode: "cancelled",
      errorMessage: "cancelled by operator",
      cliResumeRef: "resume-existing",
    });
  });

  it("leaves a missing-account attempt untouched when its release loses", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = row();
    state.sessions.set("s", session);
    setDurableReadStorage(state, {
      getProviderAccount: async () => null,
      releaseMainCheckoutSession: async () => false,
    });
    await handleHostMessageDurable(state, message());
    expect(state.sessions.get("s")?.status).toBe("running");
  });

  it("handles both losing and successful provider cooldown writes without a message", async () => {
    for (const won of [false, true]) {
      const state = createControlPlaneState({ now: () => NOW });
      const session = row();
      state.sessions.set("s", session);
      state.providerAccounts.set("account", {
        id: "account",
        providerId: "provider",
        label: "account",
        usageLimitCooldownSeconds: 60,
      });
      setDurableReadStorage(state, {
        requeueMainCheckoutUsageLimitedSession: async () => won,
        listConnections: async () => [],
        listHostInventories: async () => [],
      });
      await handleHostMessageDurable(state, message());
      expect(state.sessions.get("s")?.status).toBe(won ? "queued" : "running");
    }
  });
});
