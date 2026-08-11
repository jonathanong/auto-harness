import { describe, expect, it } from "vitest";

import { hydrateScheduledState } from "./control-plane-hydrate-scheduled.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { BASE_COMMAND_ID } from "./control-plane-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("durable host messages and hydration", () => {
  it("applies acknowledged logs and terminal main-checkout transitions", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    const session = {
      id: "session",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      fallbacks: [],
      targetLabels: [BASE_COMMAND_ID],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue" as const,
      status: "running" as const,
      queueShard: 0,
      createdAt: NOW,
      hostId: "host",
      worktreeId: "worktree",
      attemptId: "attempt",
      assignmentConnectionId: "connection",
      mainCheckoutLease: true,
    };
    const logs: unknown[] = [];
    let release = true;
    plane.state.storage = {
      getHostLock: async () => "connection",
      getSession: async () => ({ ...session }),
      putLogFenced: async (log: unknown) => {
        logs.push(log);
        return true;
      },
      deleteLog: async () => undefined,
      acknowledgeSession: async () => true,
      releaseMainCheckoutSession: async () => release,
      putArchive: async () => undefined,
    } as never;
    await expect(
      handleHostMessageDurable(
        plane.state,
        {
          type: "session:log",
          sessionId: "session",
          stream: "stdout",
          content: "ok",
          timestamp: NOW,
          seq: 1,
        },
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    expect(logs).toHaveLength(1);
    await expect(
      handleHostMessageDurable(
        plane.state,
        { type: "session:ack", sessionId: "session", worktreeId: "worktree", attemptId: "attempt" },
        "connection",
      ),
    ).resolves.toEqual({ ok: true, sessionAcknowledged: "session" });
    await expect(
      handleHostMessageDurable(
        plane.state,
        {
          type: "session:status",
          sessionId: "session",
          worktreeId: "worktree",
          attemptId: "attempt",
          status: "completed",
          exitCode: 0,
        },
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    release = false;
    await expect(
      handleHostMessageDurable(
        plane.state,
        {
          type: "session:status",
          sessionId: "session",
          worktreeId: "worktree",
          attemptId: "attempt",
          status: "completed",
        },
        "connection",
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      handleHostMessageDurable(
        plane.state,
        { type: "host:keepalive", hostId: "other", at: NOW },
        "connection",
      ),
    ).resolves.toEqual({ ok: false, error: "agent not connected" });
  });

  it("hydrates only complete main-checkout fences", () => {
    const state = {
      sessions: new Map(),
      pendingAcks: { clear: () => undefined },
      mainCheckoutLeases: new Map(),
    };
    hydrateScheduledState(state, [
      { id: "without-host", repositoryId: "repo", mainCheckoutLease: true },
      {
        id: "leased",
        repositoryId: "repo",
        mainCheckoutLease: true,
        hostId: "host",
        assignmentConnectionId: "connection",
      },
    ] as never);
    expect(state.sessions.size).toBe(2);
    expect(state.mainCheckoutLeases.get("host\0repo")).toEqual({
      sessionId: "leased",
      connectionId: "connection",
    });
  });
});
