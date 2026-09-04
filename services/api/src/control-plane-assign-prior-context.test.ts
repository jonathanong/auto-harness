import { describe, expect, it } from "vitest";

import { buildProviderCatalog } from "./control-plane-session-target.ts";
import {
  finishedCommandSwapSourcePlane,
  registerFixtureHost,
} from "./control-plane-prior-context-test-helpers.ts";
import { planPromptPlacement } from "./queue-placement-planner.ts";

describe("assign wiring for prior-session context", () => {
  it("attaches priorContext only for a fallback resume on a capability-advertising host", () => {
    const plane = finishedCommandSwapSourcePlane(["prior-session-context"]);
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
    const plane = finishedCommandSwapSourcePlane();
    // Replace the capable host with a plain one so the fallback lands there instead.
    plane.state.hostInventories.delete("host-a");
    plane.state.connections.clear();
    plane.state.hostConnection.clear();
    plane.state.worktrees.clear();
    registerFixtureHost(plane, "host-b");
    plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    const assigns: unknown[] = [];
    plane.setOnHostMessage((_host, message) => assigns.push(message));
    plane.assignQueued();
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toMatchObject({ resumedFromSessionId: "s1" });
    expect((assigns[0] as { priorContext?: unknown }).priorContext).toBeUndefined();
  });

  it("never attaches priorContext on a native resume", () => {
    const plane = finishedCommandSwapSourcePlane();
    plane.resumeSession("s1");
    const assigns: unknown[] = [];
    plane.setOnHostMessage((_host, message) => assigns.push(message));
    plane.assignQueued();
    expect(assigns).toHaveLength(1);
    expect(assigns[0]).toMatchObject({ resume: true, cliResumeRef: "cli-1" });
    expect((assigns[0] as { priorContext?: unknown }).priorContext).toBeUndefined();
  });

  it("an overridden resume assigns on the new command with no clear_pin round trip", () => {
    const plane = finishedCommandSwapSourcePlane();
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
    const plane = finishedCommandSwapSourcePlane();
    const resumed = plane.resumeSession("s1");
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    // Simulate the pinned host disappearing so the next placement pass clears the
    // pin and falls back to fresh routing — the pointer must be baked in then too.
    plane.state.hostConnection.delete("host-a");
    plane.state.worktrees.clear();
    registerFixtureHost(plane, "host-b", ["prior-session-context"]);
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
