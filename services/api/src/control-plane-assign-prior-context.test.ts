import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { buildProviderCatalog } from "./control-plane-session-target.ts";
import { planPromptPlacement } from "./queue-placement-planner.ts";

function registerHost(plane: ControlPlane, hostId: string, capabilities: string[] = []) {
  plane.registerHost({
    hostId,
    worktrees: [
      { id: `wt-${hostId}`, name: `wt-${hostId}`, repositoryId: "repo", path: "/wt", labels: [] },
    ],
    commandProfiles: [],
    ...(capabilities.length ? { capabilities: capabilities as never } : {}),
  });
}

function finishedSourcePlane() {
  const plane = new ControlPlane({
    shardCount: 1,
    idFactory: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  plane.createCommand({
    id: "cmd-old",
    name: "old",
    argv: ["old"],
    resumeArgvTemplate: ["old", "resume", "{cliResumeRef}", "{prompt}"],
    resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
  });
  plane.createCommand({ id: "cmd-new", name: "new", argv: ["new"], appendPrompt: true });
  registerHost(plane, "host-a", ["prior-session-context"]);
  plane.createSession({
    repositoryId: "repo",
    prompt: "first",
    target: { commandId: "cmd-old" },
    timeout: 30,
  });
  plane.assignQueued();
  const session = plane.getSession("s1")!;
  plane.handleHostMessage({
    type: "session:status",
    sessionId: "s1",
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
    status: "completed",
    cliResumeRef: "cli-1",
  });
  return plane;
}

describe("assign wiring for prior-session context", () => {
  it("attaches priorContext only for a fallback resume on a capability-advertising host", () => {
    const plane = finishedSourcePlane();
    plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    const assigns: unknown[] = [];
    plane.setOnHostMessage((_host, message) => assigns.push(message));
    plane.assignQueued();
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toMatchObject({
      resumedFromSessionId: "s1",
      priorContext: { sourceSessionId: "s1" },
    });
    expect((assigns[0] as { resume?: boolean }).resume).toBeUndefined();
  });

  it("omits priorContext when the assigned host does not advertise the capability", () => {
    const plane = finishedSourcePlane();
    // Replace the capable host with a plain one so the fallback lands there instead.
    plane.state.hostInventories.delete("host-a");
    plane.state.connections.clear();
    plane.state.hostConnection.clear();
    plane.state.worktrees.clear();
    registerHost(plane, "host-b");
    plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    const assigns: unknown[] = [];
    plane.setOnHostMessage((_host, message) => assigns.push(message));
    plane.assignQueued();
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toMatchObject({ resumedFromSessionId: "s1" });
    expect((assigns[0] as { priorContext?: unknown }).priorContext).toBeUndefined();
  });

  it("never attaches priorContext on a native resume", () => {
    const plane = finishedSourcePlane();
    plane.resumeSession("s1");
    const assigns: unknown[] = [];
    plane.setOnHostMessage((_host, message) => assigns.push(message));
    plane.assignQueued();
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toMatchObject({ resume: true, cliResumeRef: "cli-1" });
    expect((assigns[0] as { priorContext?: unknown }).priorContext).toBeUndefined();
  });

  it("an overridden resume assigns on the new command with no clear_pin round trip", () => {
    const plane = finishedSourcePlane();
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    const record = plane.state.sessions.get(resumed.session.id)!;
    const catalog = buildProviderCatalog(plane.state);
    const plan = planPromptPlacement(plane.state, catalog, record, Date.parse(plane.state.now()));
    expect(plan.action).toBe("assign");
    if (plan.action !== "assign") return;
    expect(plan.candidates[0]?.route.commandId).toBe("cmd-new");
  });

  it("bakes the prior-context pointer into resolvedArgv after a pin-expiry clear_pin", () => {
    const plane = finishedSourcePlane();
    const resumed = plane.resumeSession("s1");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    // Simulate the pinned host disappearing so the next placement pass clears the
    // pin and falls back to fresh routing — the pointer must be baked in then too.
    plane.state.hostConnection.delete("host-a");
    plane.state.worktrees.clear();
    registerHost(plane, "host-b", ["prior-session-context"]);
    const assigns: unknown[] = [];
    plane.setOnHostMessage((_host, message) => assigns.push(message));
    plane.assignQueued();
    expect(assigns).toHaveLength(1);
    expect((assigns[0] as { resolvedArgv: string[] }).resolvedArgv.join(" ")).toContain(
      ".auto-harness/prior-session.md",
    );
    expect(assigns[0]).toMatchObject({ priorContext: { sourceSessionId: "s1" } });
  });
});
