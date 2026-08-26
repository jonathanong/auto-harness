/* eslint-disable max-lines -- operator CRUD + schedule fire share one fixture. */
import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import {
  baseSessionBody,
  putScheduleOrThrow,
  seedBaseCommand,
} from "./control-plane-test-helpers.ts";

describe("ControlPlane operator management", () => {
  it("repository CRUD", () => {
    const plane = new ControlPlane({
      repositoryIdFactory: () => "repo-auto",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(plane.createRepository({ name: "", url: "x" }).ok).toBe(false);
    expect(plane.createRepository({ name: "Demo", url: "x" }).ok).toBe(false); // must be a slug
    const created = plane.createRepository({
      id: "demo",
      name: "demo",
      url: "/tmp/demo",
      defaultBranch: "main",
      setupScript: "setup.sh",
      terminalHookScript: "hook.sh",
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.repository).toMatchObject({
        id: "demo",
        name: "demo",
        url: "/tmp/demo",
        defaultBranch: "main",
        setupScript: "setup.sh",
        terminalHookScript: "hook.sh",
      });
    }
    expect(plane.createRepository({ id: "demo", name: "x", url: "y" }).ok).toBe(false);
    expect(plane.createRepository({ name: "demo", url: "y" }).ok).toBe(false); // name already in use
    expect(plane.getRepository("demo")?.name).toBe("demo");
    expect(plane.getRepository("missing")).toBeNull();
    expect(plane.listRepositories().map((r) => r.id)).toContain("demo");

    const auto = plane.createRepository({ name: "auto", url: "git://auto" });
    expect(auto.ok).toBe(true);
    if (auto.ok) {
      expect(auto.repository.id).toBe("repo-auto");
    }

    // default repositoryIdFactory (UUIDv7)
    const defaultIds = new ControlPlane({ now: () => "t" });
    const gen = defaultIds.createRepository({ name: "g", url: "u" });
    expect(gen.ok).toBe(true);
    if (gen.ok) {
      expect(gen.repository.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }

    const updated = plane.updateRepository("demo", {
      name: "demo2",
      url: "/tmp/demo2",
      defaultBranch: "develop",
      setupScript: "s2",
      terminalHookScript: "h2",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.repository.name).toBe("demo2");
      expect(updated.repository.defaultBranch).toBe("develop");
    }
    expect(plane.updateRepository("nope", { name: "x" }).ok).toBe(false);
    expect(plane.updateRepository("demo", { name: "auto" }).ok).toBe(false); // name taken by another repo
    expect(plane.deleteRepository("demo").ok).toBe(true);
    expect(plane.getRepository("demo")).toBeNull();
    expect(plane.deleteRepository("demo").ok).toBe(false);
  });

  it("schedule CRUD + manual trigger provenance", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      scheduleIdFactory: () => "sched-auto",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    plane.createCommand({
      id: "cmd-echo",
      name: "echo-prompt",
      argv: ["echo"],
      providerId: null,
    });
    plane.createCommand({
      id: "cmd-codex",
      name: "codex-fix",
      argv: ["codex"],
      providerId: null,
    });
    plane.createCommand({ id: "cmd-c", name: "c", argv: ["c"], providerId: null });
    const sched = putScheduleOrThrow(plane, {
      id: "sched-1",
      repositoryId: "repo-1",
      name: "nightly",
      target: { commandId: "cmd-echo" },
      cron: "0 0 * * *",
      timeout: 60,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
      enabled: true,
      prompt: "run nightly checks",
    });
    expect(sched.id).toBe("sched-1");
    expect(plane.getSchedule("sched-1")?.name).toBe("nightly");
    expect(plane.getSchedule("missing")).toBeNull();
    expect(plane.listSchedules()).toHaveLength(1);
    const updated = plane.updateSchedule("sched-1", {
      name: "nightly2",
      target: { commandId: "cmd-codex" },
      cron: "0 1 * * *",
      timeout: 90,
      nextRunAt: "2026-01-02T00:00:00.000Z",
      enabled: true,
      ref: "develop",
      repositoryId: "repo-2",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.schedule.name).toBe("nightly2");
      expect(updated.schedule.ref).toBe("develop");
    }
    expect(plane.updateSchedule("nope", { name: "x" }).ok).toBe(false);
    const auto = putScheduleOrThrow(plane, {
      repositoryId: "r",
      name: "a",
      target: { commandId: "cmd-c" },
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    });
    expect(auto.id).toBe("sched-auto");

    const fired = plane.triggerSchedule("sched-1", "2026-01-02T00:00:00.000Z");
    expect(fired.ok).toBe(true);
    if (fired.ok) {
      expect(fired.session.type).toBe("scheduled");
      expect(fired.session.source).toBe("schedule");
      expect(fired.session.targetDisplayNames).toEqual(["codex-fix"]);
      expect(fired.session.ref).toBe("develop");
      expect(fired.session.prompt).toBe("run nightly checks");
    }
    expect(plane.getSchedule("sched-1")).toMatchObject({
      lastRunAt: "2026-01-02T00:00:00.000Z",
      nextRunAt: "2026-01-02T01:00:00.000Z",
    });

    plane.updateSchedule("sched-1", { enabled: false });
    expect(plane.triggerSchedule("sched-1").ok).toBe(false);
    expect(plane.triggerSchedule("missing").ok).toBe(false);

    // createSession failure path on trigger (empty repositoryId after patch)
    plane.updateSchedule("sched-1", { enabled: true, repositoryId: "" });
    expect(plane.triggerSchedule("sched-1").ok).toBe(false);

    expect(plane.deleteSchedule("sched-1").ok).toBe(true);
    expect(plane.deleteSchedule("sched-1").ok).toBe(false); // already gone
  });

  it("cancelSession queued and running", () => {
    const messages: HostWireMessage[] = [];
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
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
      hostId: "a1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody({ prompt: "queued-cancel" }));
    const queued = plane.listSessions().find((s) => s.prompt === "queued-cancel")!;
    const cancelQ = plane.cancelSession(queued.id);
    expect(cancelQ.ok).toBe(true);
    if (cancelQ.ok) {
      expect(cancelQ.session.status).toBe("cancelled");
      expect(cancelQ.session.errorMessage).toBe("cancelled by operator");
    }
    expect(plane.cancelSession(queued.id).ok).toBe(false);
    expect(plane.cancelSession("missing").ok).toBe(false);
    plane.createSession(baseSessionBody({ prompt: "running-cancel" }));
    plane.assignQueued();
    const running = plane.listSessions().find((s) => s.prompt === "running-cancel")!;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: running.id,
      worktreeId: running.worktreeId as string,
      attemptId: running.attemptId as string,
    });
    const cancelR = plane.cancelSession(running.id);
    expect(cancelR.ok).toBe(true);
    if (cancelR.ok) {
      expect(cancelR.session.status).toBe("cancelled");
    }
    expect(messages.some((m) => m.type === "session:cancel")).toBe(true);
    // worktree held until late terminal for running cancel
    expect(plane.getWorktree("wt-1")?.status).toBe("busy");
  });
});
