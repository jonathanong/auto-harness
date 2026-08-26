import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { BASE_COMMAND_ID, baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane API edges", () => {
  it("POST fields include ref, target labels, concurrencyId, metadata, url", () => {
    const plane = new ControlPlane({
      publicBaseUrl: "http://ui",
      idFactory: () => "sess-x",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(plane);
    const r = plane.createSession(
      baseSessionBody({
        ref: "main",
        concurrencyId: "ck",
        metadata: { pr: 1 },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.session.url).toBe("http://ui/sessions/sess-x");
      expect(r.session.ref).toBe("main");
      expect(r.session.targetDisplayNames).toEqual(["echo-prompt"]);
      expect(r.session.concurrencyId).toBe("ck");
      expect(r.session.metadata).toEqual({ pr: 1 });
    }
  });

  it("evaluateCron creates scheduled sessions", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T01:00:00.000Z",
      scheduleIdFactory: () => "sched-1",
    });
    seedBaseCommand(plane);
    plane.putSchedule({
      repositoryId: "repo-1",
      name: "job",
      target: { commandId: BASE_COMMAND_ID },
      cron: "0 * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
    });
    const created = plane.evaluateCron("2026-01-01T02:00:00.000Z");
    expect(created).toHaveLength(1);
    expect(created[0]?.source).toBe("schedule");
    expect(plane.evaluateCron("2026-01-01T02:00:00.000Z")).toHaveLength(0);
  });

  it("covers agent message errors and pin expiry", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    expect(plane.handleHostMessage({ type: "session:ack", sessionId: "nope" }).ok).toBe(false);
    expect(
      plane.handleHostMessage({
        type: "host:keepalive",
        hostId: "missing",
        at: "t",
      }).ok,
    ).toBe(false);
    expect(plane.resumeSession("nope").ok).toBe(false);

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
    const assigned = plane.assignQueued()[0]!.session;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-1",
      worktreeId: assigned.worktreeId!,
      attemptId: assigned.attemptId!,
      status: "completed",
    });
    const resumed = plane.resumeSession("sess-1", {
      pinExpiresAt: "2025-01-01T00:00:00.000Z",
    });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      plane.assignQueued();
      expect(plane.getSession(resumed.session.id)?.status).toBe("running");
    }
    expect((await plane.archiveSessionLogs("empty-sess")).body).toBe("");
    expect(plane.getAckDeadlineMs()).toBeGreaterThan(0);
  });
});
