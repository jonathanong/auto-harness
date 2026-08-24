/* eslint-disable max-lines */
import { describe, expect, it } from "vitest";
import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("ControlPlane retry and resume invariants", () => {
  it("usage_limit on a providerless command suppresses that target", () => {
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const plane = new ControlPlane({
      now: () => new Date(nowMs).toISOString(),
      idFactory: () => "sess-u",
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
    const usageAssignment = plane.assignQueued().find((a) => a.session.id === "sess-u")!;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: "sess-u",
      worktreeId: usageAssignment.worktree.id,
      attemptId: usageAssignment.session.attemptId!,
    });

    plane.handleHostMessage({
      type: "session:status",
      sessionId: "sess-u",
      worktreeId: usageAssignment.worktree.id,
      attemptId: usageAssignment.session.attemptId!,
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(plane.getSession("sess-u")?.status).toBe("queued");
    expect(plane.getSession("sess-u")?.suppressedTargetIndexes).toEqual([0]);
  });

  it("Invariant 7 / D5: resume pins agent only; works after original worktree reused", () => {
    let n = 0;
    const plane = new ControlPlane({
      idFactory: () => `sess-${++n}`,
      now: () => "2026-01-01T00:00:00.000Z",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-a",
      name: "wt-a",
      hostId: "agent-1",
      repositoryId: "repo-1",
      path: "/a",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.seedWorktree({
      id: "wt-b",
      name: "wt-b",
      hostId: "agent-1",
      repositoryId: "repo-1",
      path: "/b",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.createSession(baseSessionBody({ ref: "feature/x" }));
    const firstAssign = plane.assignQueued();
    const originalWt = firstAssign[0]!.worktree.id;
    const firstAttempt = firstAssign[0]!.session.attemptId!;
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: firstAssign[0]!.session.id,
      worktreeId: originalWt,
      attemptId: firstAttempt,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: firstAssign[0]!.session.id,
      worktreeId: originalWt,
      attemptId: firstAttempt,
      status: "completed",
      cliResumeRef: "cli-abc",
    });

    // Original worktree reused by intervening session
    plane.createSession(baseSessionBody({ prompt: "other" }));
    const intervening = plane.assignQueued();
    const interveningWt = intervening[0]!.worktree.id;

    const resumed = plane.resumeSession(firstAssign[0]!.session.id);
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      return;
    }
    expect(resumed.session.pinnedHostId).toBe("agent-1");
    expect(resumed.session.ref).toBe("feature/x");
    // Finish intervening so wt free; resume can land on different worktree path
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: intervening[0]!.session.id,
      worktreeId: interveningWt,
      attemptId: intervening[0]!.session.attemptId!,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: intervening[0]!.session.id,
      worktreeId: interveningWt,
      attemptId: intervening[0]!.session.attemptId!,
      status: "completed",
    });
    const resumeAssign = plane.assignQueued();
    const hit = resumeAssign.find((a) => a.session.id === resumed.session.id);
    expect(hit).toBeTruthy();
    expect(hit?.worktree.hostId).toBe("agent-1");
    // Worktree is not pinned — may differ from original after reuse.
    expect(["wt-a", "wt-b"]).toContain(hit?.worktree.id);
    expect(["wt-a", "wt-b"]).toContain(originalWt);
    expect(["wt-a", "wt-b"]).toContain(interveningWt);
  });

  it("keeps a native resume on its exact fallback route, then clears every pin for a fresh run", () => {
    const now = "2026-01-01T00:00:00.000Z";
    let n = 0;
    const plane = new ControlPlane({ idFactory: () => `s${++n}`, now: () => now, shardCount: 1 });
    const assignments: Extract<HostWireMessage, { type: "session:assign" }>[] = [];
    plane.setOnHostMessage((_hostId, message) => {
      if (message.type === "session:assign") assignments.push(message);
    });
    plane.createProvider({ id: "provider", name: "vendor", defaultCommandId: "primary" });
    plane.createProviderAccount({ id: "account", providerId: "provider", label: "a" });
    plane.createCommand({
      id: "primary",
      name: "primary",
      argv: ["primary"],
      providerId: "provider",
    });
    plane.createCommand({
      id: "fallback",
      name: "fallback",
      argv: ["fallback"],
      providerId: "provider",
    });
    plane.registerHost({
      hostId: "host",
      worktrees: [{ id: "wt", name: "wt", repositoryId: "repo", path: "/wt", labels: [] }],
      commandProfiles: [],
      providerAccountReadiness: [
        { providerAccountId: "account", ready: true, fingerprint: "a".repeat(64) },
      ],
    });
    plane.putHostInventory("host", {
      repositories: [
        {
          id: "repo",
          path: "/repo",
          worktrees: [{ id: "wt", name: "wt", path: "/wt", labels: [] }],
        },
      ],
      providerAccounts: [{ providerAccountId: "account" }],
      commandProfiles: {},
    });
    const created = plane.createSession({
      repositoryId: "repo",
      prompt: "p",
      target: { commandId: "primary" },
      fallbacks: [{ commandId: "fallback" }],
      timeout: 1,
    });
    expect(created.ok).toBe(true);
    // No primary command is available on the source run, forcing fallback 1.
    plane.state.commands.delete("primary");
    const source = plane.assignQueued()[0]!.session;
    const sourceWorktreeId = source.worktreeId!;
    const sourceAttemptId = source.attemptId!;
    expect(source.resolvedRoute).toMatchObject({
      targetIndex: 1,
      commandId: "fallback",
      providerAccountId: "account",
    });
    plane.handleHostMessage({
      type: "session:ack",
      sessionId: source.id,
      worktreeId: sourceWorktreeId,
      attemptId: sourceAttemptId,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: source.id,
      worktreeId: sourceWorktreeId,
      attemptId: sourceAttemptId,
      status: "completed",
      cliResumeRef: "native",
    });

    // Primary becomes valid again but shares the same provider/account. Native
    // continuation must still use fallback index 1 and its exact command.
    plane.createCommand({
      id: "primary",
      name: "primary",
      argv: ["primary"],
      providerId: "provider",
    });
    const resumed = plane.resumeSession(source.id);
    expect(resumed.ok).toBe(true);
    const native = plane.assignQueued()[0]!.session;
    expect(assignments.at(-1)).toMatchObject({
      resume: true,
      resumedFromSessionId: source.id,
    });
    const nativeWorktreeId = native.worktreeId!;
    const nativeAttemptId = native.attemptId!;
    expect(native.resolvedRoute).toMatchObject({
      targetIndex: 1,
      commandId: "fallback",
      providerAccountId: "account",
    });

    plane.handleHostMessage({
      type: "session:ack",
      sessionId: native.id,
      worktreeId: nativeWorktreeId,
      attemptId: nativeAttemptId,
    });
    plane.handleHostMessage({
      type: "session:status",
      sessionId: native.id,
      worktreeId: nativeWorktreeId,
      attemptId: nativeAttemptId,
      status: "completed",
    });
    plane.state.commands.delete("fallback");
    const fresh = plane.resumeSession(native.id);
    expect(fresh.ok).toBe(true);
    const freshAssigned = plane.assignQueued()[0]!.session;
    expect(freshAssigned.resumeFallback).toBe(true);
    expect(freshAssigned.cliResumeRef).toBeUndefined();
    expect(freshAssigned.resolvedRoute).toMatchObject({ targetIndex: 0, commandId: "primary" });
    expect(assignments.at(-1)).toMatchObject({ resumedFromSessionId: native.id });
    expect(assignments.at(-1)).not.toHaveProperty("resume");
  });
});
