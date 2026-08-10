import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("concurrency lock lifecycle", () => {
  it("cancels queued work by releasing its worktree and lock", () => {
    const released: string[] = [];
    const plane = new ControlPlane({ idFactory: () => "sess-1", now: () => "now" });
    seedBaseCommand(plane);
    plane.seedWorktree({
      id: "wt-1",
      name: "wt-1",
      hostId: "host-1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "sess-1",
    });
    plane.createSession(baseSessionBody({ concurrencyId: "cancel-lock" }));
    Object.assign(plane.state.sessions.get("sess-1")!, {
      worktreeId: "wt-1",
      hostId: "host-1",
    });
    plane.state.storage = {
      putSession: async () => {},
      putWorktree: async () => {},
      releaseConcurrencyLock: async (concurrencyId: string) => released.push(concurrencyId),
    } as never;

    expect(plane.cancelSession("sess-1")).toMatchObject({
      ok: true,
      session: { status: "cancelled", worktreeId: null, hostId: null },
    });
    expect(plane.getWorktree("wt-1")).toMatchObject({ status: "idle", currentSessionId: null });
    expect(released).toEqual(["cancel-lock"]);
  });

  it("asks the agent to cancel running work without releasing its lock early", () => {
    const messages: HostWireMessage[] = [];
    const released: string[] = [];
    const plane = new ControlPlane({
      idFactory: () => "sess-1",
      now: () => "now",
      onHostMessage: (_hostId, message) => messages.push(message),
    });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody({ concurrencyId: "running-lock" }));
    Object.assign(plane.state.sessions.get("sess-1")!, {
      status: "running",
      hostId: "host-1",
      worktreeId: "wt-1",
    });
    plane.state.storage = {
      putSession: async () => {},
      releaseConcurrencyLock: async (concurrencyId: string) => released.push(concurrencyId),
    } as never;

    expect(plane.cancelSession("sess-1")).toMatchObject({
      ok: true,
      session: { status: "cancelled", worktreeId: "wt-1" },
    });
    expect(messages).toEqual([{ type: "session:cancel", sessionId: "sess-1" }]);
    expect(released).toEqual([]);
  });

  it("handles durable cancellation races and terminal/running states", async () => {
    let id = 0;
    let cancelWins = false;
    const plane = new ControlPlane({ idFactory: () => `durable-${++id}`, now: () => "now" });
    seedBaseCommand(plane);
    plane.state.storage = {
      putSession: async () => {},
      putWorktree: async () => {},
      cancelQueuedSession: async () => cancelWins,
    } as never;

    await expect(plane.cancelSessionDurable("missing")).resolves.toEqual({
      ok: false,
      error: "session not found",
    });
    plane.createSession(baseSessionBody());
    plane.forceStatus("durable-1", "completed");
    await expect(plane.cancelSessionDurable("durable-1")).resolves.toMatchObject({
      ok: false,
      error: "session already terminal: completed",
    });

    plane.createSession(baseSessionBody());
    await expect(plane.cancelSessionDurable("durable-2")).resolves.toEqual({
      ok: false,
      error: "session changed before cancellation",
    });
    plane.seedWorktree({
      id: "durable-wt",
      name: "durable-wt",
      hostId: "host-1",
      repositoryId: "repo-1",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "durable-2",
    });
    Object.assign(plane.state.sessions.get("durable-2")!, { worktreeId: "durable-wt" });
    cancelWins = true;
    await expect(plane.cancelSessionDurable("durable-2")).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });

    plane.createSession(baseSessionBody());
    Object.assign(plane.state.sessions.get("durable-3")!, {
      status: "running",
      hostId: "host-1",
    });
    await expect(plane.cancelSessionDurable("durable-3")).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });
  });
});
