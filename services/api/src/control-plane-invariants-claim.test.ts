import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import {
  BASE_COMMAND_ID,
  baseSessionBody,
  putScheduleOrThrow,
  seedBaseCommand,
} from "./control-plane-test-helpers.ts";

describe("ControlPlane claim invariants", () => {
  it("hydrate and settle are no-ops without storage", async () => {
    const plane = new ControlPlane();
    await plane.hydrateFromStorage();
    await plane.settleStorage();
    expect(plane.listSessions()).toEqual([]);
  });

  it("Invariant 1: exclusive worktree claim under concurrent assign", () => {
    const messages: HostWireMessage[] = [];
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `sess-${++n}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onHostMessage: (_id, msg) => {
        messages.push(msg);
      },
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "agent-1",
      repositoryId: "repo-1",
      path: "/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody());
    plane.createSession(baseSessionBody({ prompt: "second" }));

    const a1 = plane.assignQueued();
    expect(a1).toHaveLength(1);
    expect(a1[0]?.worktree.id).toBe("wt-1");
    const a2 = plane.assignQueued();
    expect(a2).toHaveLength(0);
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
    expect(messages.filter((m) => m.type === "session:assign")).toHaveLength(1);
  });

  it("Invariant 3: concurrent agent register leaves one connection", () => {
    const plane = new ControlPlane({
      connectionIdFactory: (() => {
        let n = 0;
        return () => `conn-${++n}`;
      })(),
    });
    const first = plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r", path: "/p", labels: ["echo"] }],
      commandProfiles: ["echo-prompt"],
    });
    const second = plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r", path: "/p", labels: ["echo"] }],
      commandProfiles: ["echo-prompt"],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (first.ok) {
      plane.disconnectHost(first.connectionId);
    }
    const third = plane.registerHost({
      hostId: "a1",
      worktrees: [{ id: "wt-1", name: "wt-1", repositoryId: "r", path: "/p", labels: ["echo"] }],
      commandProfiles: ["echo-prompt"],
      replaceExisting: true,
    });
    expect(third.ok).toBe(true);
  });

  it("Invariant 4: concurrent cron claim creates at most one session", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      scheduleIdFactory: () => "sched-1",
    });
    seedBaseCommand(plane);
    const schedule = putScheduleOrThrow(plane, {
      repositoryId: "repo-1",
      name: "hourly",
      commandId: BASE_COMMAND_ID,
      cron: "0 * * * *",
      timeout: 60,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    const expected = schedule.nextRunAt;
    const s1 = plane.tryClaimScheduleFire(schedule.id, expected, "2026-01-01T00:00:01.000Z");
    const s2 = plane.tryClaimScheduleFire(schedule.id, expected, "2026-01-01T00:00:01.000Z");
    expect(s1).not.toBeNull();
    expect(s2).toBeNull();
    expect(plane.listSessions()).toHaveLength(1);
  });

  it("Invariant 5: same-ms logs ordered by seq", () => {
    const plane = new ControlPlane();
    const ts = "2026-01-01T00:00:00.000Z";
    plane.appendLog({
      sessionId: "s",
      stream: "stdout",
      content: "second",
      timestamp: ts,
      seq: 2,
    });
    plane.appendLog({
      sessionId: "s",
      stream: "stdout",
      content: "first",
      timestamp: ts,
      seq: 1,
    });
    const logs = plane.getLogs("s");
    expect(logs.map((l) => l.content)).toEqual(["first", "second"]);
    expect(logs[0]!.timestampSeq < logs[1]!.timestampSeq).toBe(true);
  });

  it("Invariant 2: no-ack requeues and frees worktree", () => {
    const plane = new ControlPlane({
      ackDeadlineMs: 100,
      now: () => "2026-01-01T00:00:00.000Z",
      idFactory: () => "sess-1",
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
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
    const requeued = plane.enforceAckDeadlines(Date.parse("2026-01-01T00:00:00.000Z") + 200);
    expect(requeued).toEqual(["sess-1"]);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    expect(plane.getWorktree("wt-1")?.status).toBe("idle");
  });
});
