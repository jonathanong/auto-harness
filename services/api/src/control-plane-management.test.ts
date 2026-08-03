import { describe, expect, it } from "vitest";

import type { AgentWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody } from "./control-plane-test-helpers.ts";

describe("ControlPlane operator management", () => {
  it("repository CRUD", () => {
    const plane = new ControlPlane({
      repositoryIdFactory: () => "repo-auto",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(plane.createRepository({ name: "", url: "x" }).ok).toBe(false);
    const created = plane.createRepository({
      id: "demo",
      name: "Demo",
      url: "/tmp/demo",
      defaultBranch: "main",
      setupScript: "setup.sh",
      terminalHookScript: "hook.sh",
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.repository).toMatchObject({
        id: "demo",
        name: "Demo",
        url: "/tmp/demo",
        defaultBranch: "main",
        setupScript: "setup.sh",
        terminalHookScript: "hook.sh",
      });
    }
    expect(plane.createRepository({ id: "demo", name: "x", url: "y" }).ok).toBe(false);
    expect(plane.getRepository("demo")?.name).toBe("Demo");
    expect(plane.getRepository("missing")).toBeNull();
    expect(plane.listRepositories().map((r) => r.id)).toContain("demo");

    const auto = plane.createRepository({ name: "Auto", url: "git://auto" });
    expect(auto.ok).toBe(true);
    if (auto.ok) {
      expect(auto.repository.id).toBe("repo-auto");
    }

    // default repositoryIdFactory (random id)
    const defaultIds = new ControlPlane({ now: () => "t" });
    const gen = defaultIds.createRepository({ name: "G", url: "u" });
    expect(gen.ok).toBe(true);
    if (gen.ok) {
      expect(gen.repository.id.startsWith("repo-")).toBe(true);
    }

    const updated = plane.updateRepository("demo", {
      name: "Demo2",
      url: "/tmp/demo2",
      defaultBranch: "develop",
      setupScript: "s2",
      terminalHookScript: "h2",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.repository.name).toBe("Demo2");
      expect(updated.repository.defaultBranch).toBe("develop");
    }
    expect(plane.updateRepository("nope", { name: "x" }).ok).toBe(false);
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
    const sched = plane.putSchedule({
      id: "sched-1",
      repositoryId: "repo-1",
      name: "nightly",
      commandProfile: "echo-prompt",
      cron: "0 0 * * *",
      timeout: 60,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      ref: "main",
      enabled: true,
    });
    expect(sched.id).toBe("sched-1");
    expect(plane.getSchedule("sched-1")?.name).toBe("nightly");
    expect(plane.getSchedule("missing")).toBeNull();
    expect(plane.listSchedules()).toHaveLength(1);

    const updated = plane.updateSchedule("sched-1", {
      name: "nightly2",
      commandProfile: "codex-fix",
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

    const auto = plane.putSchedule({
      repositoryId: "r",
      name: "a",
      commandProfile: "c",
      cron: "* * * * *",
      timeout: 1,
      nextRunAt: "t",
    });
    expect(auto.id).toBe("sched-auto");

    const fired = plane.triggerSchedule("sched-1", "2026-01-02T00:00:00.000Z");
    expect(fired.ok).toBe(true);
    if (fired.ok) {
      expect(fired.session.type).toBe("scheduled");
      expect(fired.session.source).toBe("schedule");
      expect(fired.session.commandProfile).toBe("codex-fix");
      expect(fired.session.ref).toBe("develop");
      expect(fired.session.prompt).toBe("scheduled:nightly2");
    }
    expect(plane.getSchedule("sched-1")?.lastRunAt).toBe("2026-01-02T00:00:00.000Z");
    expect(plane.getSchedule("sched-1")?.nextRunAt).toBe("2026-01-02T00:01:00.000Z");

    plane.updateSchedule("sched-1", { enabled: false });
    expect(plane.triggerSchedule("sched-1").ok).toBe(false);
    expect(plane.triggerSchedule("missing").ok).toBe(false);

    // createSession failure path on trigger (empty repositoryId after patch)
    plane.updateSchedule("sched-1", { enabled: true, repositoryId: "" });
    expect(plane.triggerSchedule("sched-1").ok).toBe(false);

    expect(plane.deleteSchedule("sched-1").ok).toBe(true);
    expect(plane.deleteSchedule("sched-1").ok).toBe(false);
  });

  it("cancelSession queued and running", () => {
    const messages: AgentWireMessage[] = [];
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
      onAgentMessage: (_id, msg) => {
        messages.push(msg);
      },
    });
    plane.seedWorktree({
      id: "wt-1",
      agentId: "a1",
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
    plane.handleAgentMessage({ type: "session:ack", sessionId: running.id });
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
