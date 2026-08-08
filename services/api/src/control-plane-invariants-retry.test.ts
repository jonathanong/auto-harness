import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane retry and resume invariants", () => {
  it("Invariant 6: usage_limit retries under cap only", () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const plane = new ControlPlane({
      usageLimitRetryCeiling: 2,
      now: () => new Date(nowMs).toISOString(),
      idFactory: () => "sess-u",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.assignQueued();
    plane.handleHostMessage({ type: "session:ack", sessionId: "sess-u" });

    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-u",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("sess-u")?.status).toBe("queued");
    expect(plane.getSession("sess-u")?.retryCount).toBe(1);

    nowMs += 60_000;
    plane.assignQueued();
    plane.handleHostMessage({ type: "session:ack", sessionId: "sess-u" });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-u",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("sess-u")?.retryCount).toBe(2);
    expect(plane.getSession("sess-u")?.status).toBe("queued");

    nowMs += 60_000;
    plane.assignQueued();
    plane.handleHostMessage({ type: "session:ack", sessionId: "sess-u" });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-u",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("sess-u")?.status).toBe("failed");
  });

  it("Invariant 7 / D5: resume pins agent only; works after original worktree reused", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-a",
      name: "wt-a",
      hostId: "agent-1",
      repositoryId: "repo-1",
      path: "/a",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.seedWorktree({
      id: "wt-b",
      name: "wt-b",
      hostId: "agent-1",
      repositoryId: "repo-1",
      path: "/b",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody({ ref: "feature/x" }));
    const firstAssign = plane.assignQueued();
    const originalWt = firstAssign[0]!.worktree.id;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: firstAssign[0]!.session.id,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: firstAssign[0]!.session.id,
      status: "completed",
      cliResumeRef: "cli-abc",
    });

    // Original worktree reused by intervening session
    plane.createSession(baseSessionBody({ prompt: "other" }));
    const intervening = plane.assignQueued();
    const interveningWt = intervening[0]!.worktree.id;

    const resumed = plane.resumeSession(firstAssign[0]!.session.id);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      return;
    }
    expect(resumed.session.pinnedHostId).toBe("agent-1");
    expect(resumed.session.ref).toBe("feature/x");
    // Finish intervening so wt free; resume can land on different worktree path
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: intervening[0]!.session.id,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: intervening[0]!.session.id,
      status: "completed",
    });
    const resumeAssign = plane.assignQueued();
    const hit = resumeAssign.find((a) => a.session.id === resumed.session.id);
    expect(hit).toBeTruthy();
    expect(hit?.worktree.hostId).toBe("agent-1");
    // Worktree is not pinned — may differ from original after reuse.
    expect(["wt-a", "wt-b"]).toContain(hit?.worktree.id);
    expect(["wt-a", "wt-b"]).toContain(originalWt);
    expect(["wt-a", "wt-b"]).toContain(interveningWt);
  });
});
