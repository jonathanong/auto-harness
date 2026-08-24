/* eslint-disable max-lines -- optional finish fields share the durable terminal fixture. */
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
  it("strongly reads a late drain cancellation before choosing its release path", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const running = row();
    const cancelled = row({ status: "cancelled", completedAt: NOW });
    state.sessions.set("s", running);
    const reads: unknown[][] = [];
    const releases: Record<string, unknown>[] = [];
    setDurableReadStorage(state, {
      getSession: async (...args: unknown[]) => {
        reads.push(args);
        return cancelled;
      },
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        releases.push(input);
        return true;
      },
    });
    await handleHostMessageDurable(state, message({ status: "completed" }));
    expect(reads).toEqual([["s", true]]);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ expectedStatus: "cancelled", status: "cancelled" });
  });

  it("finishes a leased scheduled attempt with every optional report field", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.sessions.set("s", row({ concurrencyId: "concurrency" }));
    let input: Record<string, unknown> = {};
    setDurableReadStorage(state, {
      releaseMainCheckoutSession: async (next: Record<string, unknown>) => {
        input = next;
        return true;
      },
      putArchive: async () => undefined,
    });
    await handleHostMessageDurable(
      state,
      message({
        status: "failed",
        errorCode: "command_failed",
        exitCode: 1,
        errorMessage: "boom",
        cliResumeRef: "resume",
      }),
    );
    expect(input).toMatchObject({
      status: "failed",
      exitCode: 1,
      errorCode: "command_failed",
      reason: "boom",
      cliResumeRef: "resume",
      concurrencyId: "concurrency",
    });
    expect(state.sessions.get("s")).toMatchObject({
      status: "failed",
      exitCode: 1,
      errorCode: "command_failed",
      errorMessage: "boom",
      cliResumeRef: "resume",
    });
  });

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

  it("does not load a provider account for a late cancelled usage_limit", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    state.sessions.set("s", row({ status: "cancelled", completedAt: NOW }));
    let loaded = 0;
    setDurableReadStorage(state, {
      getProviderAccount: async () => {
        loaded += 1;
        throw new Error("catalog unavailable");
      },
      releaseMainCheckoutSession: async () => true,
    });
    await expect(handleHostMessageDurable(state, message())).resolves.toEqual({ ok: true });
    expect(loaded).toBe(0);
  });

  it("treats a cache miss as a missing provider account during usage-limit planning", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const session = row({
      type: "prompt",
      source: "api",
      mainCheckoutLease: undefined,
      assignmentConnectionId: undefined,
      worktreeId: "w",
      resolvedRoute: {
        targetIndex: 0,
        commandId: "cmd",
        providerAccountId: "account",
        hostId: "host",
        worktreeId: "w",
        attemptId: "attempt",
      },
    });
    state.sessions.set("s", session);
    state.storage = { getSession: async () => session } as never;
    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: "s",
        worktreeId: "w",
        attemptId: "attempt",
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).resolves.toEqual({ ok: true });
    expect(state.sessions.get("s")?.status).toBe("running");
  });
});
