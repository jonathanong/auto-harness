import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  finishedCommandSwapSourcePlane,
  minimalSession,
} from "./control-plane-prior-context-test-helpers.ts";

describe("resume target/fallbacks override", () => {
  it("rebinds to the new command and drops every native-resume pin field", () => {
    const plane = finishedCommandSwapSourcePlane();
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
    const plane = finishedCommandSwapSourcePlane();
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.session.prompt).toContain(".auto-harness/prior-session.md");
  });

  it("succeeds even though the source never captured a cliResumeRef for its old template", () => {
    const plane = finishedCommandSwapSourcePlane();
    // Overwrite so the source looks like it never captured a ref — the guard that
    // blocks this for a *native* resume must not block a target override.
    plane.state.sessions.get("s1")!.cliResumeRef = undefined;
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
  });

  it("recomputes targetDisplayNames from the new target", () => {
    const plane = finishedCommandSwapSourcePlane();
    const resumed = plane.resumeSession("s1", { target: { commandId: "cmd-new" } });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.session.targetDisplayNames).toEqual(["new"]);
  });

  it("accepts fallbacks alongside target and defaults fallbacks to [] when omitted", () => {
    const plane = finishedCommandSwapSourcePlane();
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
    const plane = finishedCommandSwapSourcePlane();
    expect(plane.resumeSession("s1", { fallbacks: [{ commandId: "cmd-new" }] } as never)).toEqual({
      ok: false,
      error: "fallbacks requires target",
    });
  });

  it("rejects an unknown commandId in the override", () => {
    const plane = finishedCommandSwapSourcePlane();
    expect(plane.resumeSession("s1", { target: { commandId: "does-not-exist" } })).toEqual({
      ok: false,
      error: "commandId does-not-exist not found",
    });
  });

  it("rejects a malformed target", () => {
    const plane = finishedCommandSwapSourcePlane();
    expect(plane.resumeSession("s1", { target: { commandId: 1 } } as never)).toMatchObject({
      ok: false,
    });
  });

  it("rejects duplicate target/fallback entries", () => {
    const plane = finishedCommandSwapSourcePlane();
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
    plane.state.sessions.set(
      "unassigned",
      minimalSession({
        id: "unassigned",
        target: { commandId: "cmd-new" },
        targetDisplayNames: ["new"],
      }),
    );
    expect(plane.resumeSession("unassigned", { target: { commandId: "cmd-new" } })).toEqual({
      ok: false,
      error: "source session has no agent to pin",
    });
  });
});
