import { describe, expect, it } from "vitest";

import { assignQueuedDurable, enforceAckDeadlinesDurable } from "./control-plane-assign.ts";
import { cancelSessionDurable } from "./control-plane-cancel-durable.ts";
import { ControlPlane } from "./control-plane.ts";
import { BASE_COMMAND_ID, seedBaseCommand } from "./control-plane-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

describe("durable assignment and cancellation", () => {
  it("only exposes a durable assignment after its worktree transaction wins", async () => {
    const plane = new ControlPlane({
      attemptIdFactory: () => "attempt",
      idFactory: () => "session",
      now: () => NOW,
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.state.hostConnection.set("host", "connection");
    plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const requests: Array<Record<string, unknown>> = [];
    plane.state.storage = {
      tryAssignSession: async (input: Record<string, unknown>) => {
        requests.push(input);
        return true;
      },
      listAllSessions: async () => [],
      tryRequeueSession: async () => true,
    } as never;
    const messages: unknown[] = [];
    plane.state.onHostMessage = (_host, message) => messages.push(message);

    await expect(assignQueuedDurable(plane.state)).resolves.toMatchObject([
      { session: { id: "session", status: "running", attemptId: "attempt" } },
    ]);
    expect(requests).toHaveLength(1);
    expect(messages).toHaveLength(1);
    await expect(
      enforceAckDeadlinesDurable(plane.state, Date.parse(NOW) + 61_000),
    ).resolves.toEqual(["session"]);
    expect(plane.state.sessions.get("session")).toMatchObject({ status: "queued", hostId: null });
  });

  it("persists queued and main-checkout cancellations only after their conditional transitions win", async () => {
    const plane = new ControlPlane({ idFactory: () => "session", now: () => NOW });
    seedBaseCommand(plane);
    plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const queued = plane.state.sessions.get("session")!;
    queued.concurrencyId = "key";
    let queuedWins = false;
    plane.state.storage = {
      cancelQueuedSession: async () => queuedWins,
      cancelRunningMainCheckoutSession: async () => true,
      putSession: async () => undefined,
      putWorktree: async () => undefined,
    } as never;
    await expect(cancelSessionDurable(plane.state, "missing")).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
    await expect(cancelSessionDurable(plane.state, "session")).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });
    queuedWins = true;
    plane.seedWorktree({
      id: "queued-worktree",
      name: "queued-worktree",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "session",
    });
    queued.worktreeId = "queued-worktree";
    queued.hostId = "host";
    await expect(cancelSessionDurable(plane.state, "session")).resolves.toMatchObject({ ok: true });
    expect(plane.state.worktrees.get("queued-worktree")).toMatchObject({ status: "idle" });
    await expect(cancelSessionDurable(plane.state, "session")).resolves.toEqual({
      ok: false,
      error: "session already terminal: cancelled",
    });

    plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: BASE_COMMAND_ID },
      timeout: 1,
    });
    const running = plane.state.sessions.get("session")!;
    running.status = "running";
    running.mainCheckoutLease = true;
    running.hostId = "host";
    running.assignmentConnectionId = "connection";
    running.attemptId = "attempt";
    const sent: unknown[] = [];
    plane.state.onHostMessage = (_host, message) => sent.push(message);
    await expect(cancelSessionDurable(plane.state, "session")).resolves.toMatchObject({ ok: true });
    expect(sent).toEqual([{ type: "session:cancel", sessionId: "session" }]);
  });
});
