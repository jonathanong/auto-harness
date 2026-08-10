import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane concurrency and late status", () => {
  it("Invariant 9: concurrencyKey + reject fails create", () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
    });
    seedBaseCommand(plane);
    const first = plane.createSession(
      baseSessionBody({ concurrencyKey: "k1", onConflict: "reject" }),
    );
    expect(first.ok).toBe(true);
    const second = plane.createSession(
      baseSessionBody({ concurrencyKey: "k1", onConflict: "reject" }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.code).toBe("CONFLICT");
    }
  });

  it("Invariant 9: concurrencyKey + replace supersedes active session", () => {
    const cancels: string[] = [];
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onHostMessage: (_a, msg) => {
        if (msg.type === "session:cancel") {
          cancels.push(msg.sessionId);
        }
      },
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

    // replace a queued session (no worktree claimed yet)
    expect(
      plane.createSession(baseSessionBody({ concurrencyKey: "k-q", onConflict: "queue" })).ok,
    ).toBe(true);
    expect(
      plane.createSession(
        baseSessionBody({ concurrencyKey: "k-q", onConflict: "replace", prompt: "repl-q" }),
      ).ok,
    ).toBe(true);
    expect(plane.getSession("sess-1")?.status).toBe("cancelled");
    expect(plane.getSession("sess-2")?.status).toBe("queued");
    plane.forceStatus("sess-2", "cancelled");

    // replace a running session: keep worktree busy until late terminal
    const first = plane.createSession(
      baseSessionBody({ concurrencyKey: "k-rep", onConflict: "replace" }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const assigned1 = plane.assignQueued();
    expect(assigned1.map((a) => a.session.id)).toContain(first.session.id);
    const running = assigned1.find((item) => item.session.id === first.session.id)!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: first.session.id,
      worktreeId: running.worktreeId!,
      attemptId: running.attemptId!,
    });
    expect(plane.getSession(first.session.id)?.status).toBe("running");

    const second = plane.createSession(
      baseSessionBody({
        concurrencyKey: "k-rep",
        onConflict: "replace",
        prompt: "replacement",
      }),
    );
    expect(second.ok).toBe(true);
    expect(plane.getSession(first.session.id)?.status).toBe("cancelled");
    // worktree still busy — old CLI may still be on the path
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
    expect(cancels).toContain(first.session.id);
    // cannot reassign while superseded run still holds the worktree
    expect(plane.assignQueued()).toHaveLength(0);

    // late completed must NOT flip cancelled → completed; releases worktree
    plane.handleHostMessage({
      type: "session:status",
      sessionId: first.session.id,
      worktreeId: running.worktreeId!,
      attemptId: running.attemptId!,
      status: "completed",
    });
    expect(plane.getSession(first.session.id)?.status).toBe("cancelled");
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
    const assigned2 = plane.assignQueued();
    expect(assigned2.some((a) => a.session.prompt === "replacement")).toBe(true);
  });

  it("late session:status after disconnect completes acknowledged work", () => {
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-1",
      connectionIdFactory: () => "conn-1",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    const reg = plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/w", labels: [] }],
      commandProfiles: ["echo-prompt"],
    });
    expect(reg.ok).toBe(true);
    if (!reg.ok) {
      return;
    }
    plane.createSession(baseSessionBody());
    const assigned = plane.assignQueued()[0]!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
    });
    plane.disconnectHost(reg.connectionId);
    expect(plane.getSession("sess-1")?.status).toBe("running");

    // late ack ignored
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: "sess-1",
        worktreeId: assigned.worktreeId!,
        attemptId: assigned.attemptId!,
      }).ok,
    ).toBe(true);

    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
      status: "completed",
    });
    expect(plane.getSession("sess-1")?.status).toBe("completed");
  });
});
