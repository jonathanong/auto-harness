import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane concurrency and late status", () => {
  it("deduplicates an active concurrencyId and permits a terminal re-enqueue", () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
    });
    seedBaseCommand(plane);
    const first = plane.createSession(baseSessionBody({ concurrencyId: "k1" }));
    expect(first.ok).toBe(true);
    const second = plane.createSession(baseSessionBody({ concurrencyId: "k1" }));
    expect(second).toMatchObject({ ok: true, created: false });
    if (first.ok && second.ok) {
      expect(second.session.id).toBe(first.session.id);
    }
    if (!first.ok) return;
    plane.forceStatus(first.session.id, "completed");
    expect(plane.createSession(baseSessionBody({ concurrencyId: "k1" }))).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it("deduplicates resume while the concurrency id is active", () => {
    let id = 0;
    const plane = new ControlPlane({ idFactory: () => `resume-${++id}` });
    seedBaseCommand(plane);
    const created = plane.createSession(baseSessionBody({ concurrencyId: "resume-lock" }));
    if (!created.ok) return;
    plane.state.sessions.get(created.session.id)!.hostId = "host-1";
    plane.forceStatus(created.session.id, "completed");
    const active = plane.createSession(
      baseSessionBody({ concurrencyId: "resume-lock", prompt: "already resumed" }),
    );
    expect(active).toMatchObject({ ok: true, created: true, session: { id: "resume-2" } });
    expect(plane.resumeSession(created.session.id)).toMatchObject({
      ok: true,
      created: false,
      session: { id: "resume-2" },
    });
    plane.forceStatus("resume-2", "completed");
    expect(plane.resumeSession(created.session.id)).toMatchObject({
      ok: true,
      created: true,
      session: { id: "resume-3", concurrencyId: "resume-lock" },
    });
    expect(plane.resumeSession(created.session.id)).toMatchObject({
      ok: true,
      created: false,
      session: { id: "resume-3" },
    });
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
