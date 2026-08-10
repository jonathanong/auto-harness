import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane assignment-attempt fencing", () => {
  it("ignores an old ACK and terminal status after the session is re-assigned", () => {
    const now = "2026-01-01T00:00:00.000Z";
    let attempt = 0;
    const plane = new ControlPlane({
      now: () => now,
      idFactory: () => "sess-1",
      attemptIdFactory: () => `attempt-${++attempt}`,
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "host-1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    expect(plane.createSession(baseSessionBody()).ok).toBe(true);

    const first = plane.assignQueued()[0]!;
    expect(first.session.attemptId).toBe("attempt-1");
    plane.enforceAckDeadlines(Date.parse(now) + 15_000);
    const second = plane.assignQueued()[0]!;
    expect(second.session.attemptId).toBe("attempt-2");

    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: "wt-1",
      attemptId: first.session.attemptId!,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-1",
      worktreeId: "wt-1",
      attemptId: first.session.attemptId!,
      status: "completed",
    });

    expect(plane.getSession("sess-1")).toMatchObject({
      status: "running",
      worktreeId: "wt-1",
      attemptId: "attempt-2",
    });
    expect(plane.state.pendingAcks.get("sess-1")?.attemptId).toBe("attempt-2");
  });
});
