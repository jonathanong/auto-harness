import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

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
  plane.registerHost({
    hostId: "host",
    worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
    commandProfiles: [],
  });
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

describe("resume target/fallbacks override", () => {
  it("rebinds to the new command and drops every native-resume pin field", () => {
    const plane = finishedSourcePlane();
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.session).toMatchObject({
      target: { commandId: "cmd-new" },
      fallbacks: [],
      resumeFallback: true,
    });
    const record = plane.state.sessions.get(resumed.session.id)!;
    expect(record.pinnedHostId).toBeUndefined();
    expect(record.pinnedProviderAccountId).toBeUndefined();
    expect(record.pinnedTargetIndex).toBeUndefined();
    expect(record.pinnedCommandId).toBeUndefined();
    expect(record.pinExpiresAt).toBeUndefined();
    expect(record.cliResumeRef).toBeUndefined();
    expect(record.resumeSpec).toBeUndefined();
  });

  it("appends the prior-context pointer to the prompt under an override", () => {
    const plane = finishedSourcePlane();
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.session.prompt).toContain(".auto-harness/prior-session.md");
  });

  it("succeeds even though the source never captured a cliResumeRef for its old template", () => {
    const plane = finishedSourcePlane();
    // Overwrite so the source looks like it never captured a ref — the guard that
    // blocks this for a *native* resume must not block a target override.
    plane.state.sessions.get("s1")!.cliResumeRef = undefined;
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
  });

  it("recomputes targetDisplayNames from the new target", () => {
    const plane = finishedSourcePlane();
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.session.targetDisplayNames).toEqual(["new"]);
  });

  it("accepts fallbacks alongside target and defaults fallbacks to [] when omitted", () => {
    const plane = finishedSourcePlane();
    plane.createCommand({ id: "cmd-fallback", name: "fallback", argv: ["fb"] });
    const resumed = plane.resumeSession("s1", {
      target: { commandId: "cmd-new" },
      fallbacks: [{ commandId: "cmd-fallback" }],
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.session.fallbacks).toEqual([{ commandId: "cmd-fallback" }]);
  });

  it("rejects fallbacks without target", () => {
    const plane = finishedSourcePlane();
    expect(plane.resumeSession("s1", { fallbacks: [{ commandId: "cmd-new" }] } as never)).toEqual({
      ok: false,
      error: "fallbacks requires target",
    });
  });

  it("rejects an unknown commandId in the override", () => {
    const plane = finishedSourcePlane();
    expect(plane.resumeSession("s1", { target: { commandId: "does-not-exist" } })).toEqual({
      ok: false,
      error: "commandId does-not-exist not found",
    });
  });

  it("rejects a malformed target", () => {
    const plane = finishedSourcePlane();
    expect(plane.resumeSession("s1", { target: { commandId: 1 } } as never)).toMatchObject({
      ok: false,
    });
  });

  it("rejects duplicate target/fallback entries", () => {
    const plane = finishedSourcePlane();
    expect(
      plane.resumeSession("s1", {
        target: { commandId: "cmd-new" },
        fallbacks: [{ commandId: "cmd-new" }],
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("duplicates") });
  });

  it("still requires the source to have been assigned at least once", () => {
    const plane = new ControlPlane({ shardCount: 1 });
    plane.createCommand({ id: "cmd-new", name: "new", argv: ["new"] });
    plane.state.sessions.set("unassigned", {
      id: "unassigned",
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "cmd-new" },
      fallbacks: [],
      targetDisplayNames: ["new"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "completed",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "prompt",
      source: "api",
    });
    expect(plane.resumeSession("unassigned", { target: { commandId: "cmd-new" } })).toEqual({
      ok: false,
      error: "source session has no agent to pin",
    });
  });
});
