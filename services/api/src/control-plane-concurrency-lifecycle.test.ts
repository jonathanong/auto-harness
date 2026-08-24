/* eslint-disable max-lines -- cancel payloads now include attemptId. */
import { describe, expect, it } from "vitest";

import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { setDurableReadStorage } from "./control-plane-durable-read-test-helpers.ts";
import { supersedeSession } from "./control-plane-sessions.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

describe("concurrency lock lifecycle", () => {
  it("cancels queued work by releasing its worktree and lock", async () => {
    const released: string[] = [];
    const plane = new ControlPlane({
      idFactory: () => "sess-1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
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
    setDurableReadStorage(plane.state, {
      putSession: async () => {},
      putWorktree: async () => {},
      releaseConcurrencyLock: async (concurrencyId: string) => released.push(concurrencyId),
    });

    expect(plane.cancelSession("sess-1")).toMatchObject({
      ok: true,
      session: { status: "cancelled", worktreeId: null, hostId: null },
    });
    expect(plane.getWorktree("wt-1")).toMatchObject({ status: "idle", currentSessionId: null });
    await plane.settleStorage();
    expect(released).toEqual(["cancel-lock"]);
  });

  it("asks the agent to cancel running work without releasing its lock early", () => {
    const messages: HostWireMessage[] = [];
    const released: string[] = [];
    const plane = new ControlPlane({
      idFactory: () => "sess-1",
      now: () => "2026-01-01T00:00:00.000Z",
      onHostMessage: (_hostId, message) => messages.push(message),
    });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody({ concurrencyId: "running-lock" }));
    Object.assign(plane.state.sessions.get("sess-1")!, {
      status: "running",
      hostId: "host-1",
      worktreeId: "wt-1",
      attemptId: "attempt-1",
    });
    setDurableReadStorage(plane.state, {
      putSession: async () => {},
      releaseConcurrencyLock: async (concurrencyId: string) => released.push(concurrencyId),
    });

    expect(plane.cancelSession("sess-1")).toMatchObject({
      ok: true,
      session: { status: "cancelled", worktreeId: "wt-1" },
    });
    expect(messages).toEqual([
      { type: "session:cancel", sessionId: "sess-1", attemptId: "attempt-1" },
    ]);
    expect(released).toEqual([]);
  });

  it("handles durable cancellation races and terminal/running states", async () => {
    let id = 0;
    let cancelWins = false;
    const plane = new ControlPlane({
      idFactory: () => `durable-${++id}`,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(plane);
    setDurableReadStorage(plane.state, {
      putSession: async () => {},
      putWorktree: async () => {},
      cancelQueuedSession: async () => cancelWins,
      cancelRunningSession: async () => true,
    });

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
      worktreeId: "durable-running-wt",
      assignmentConnectionId: "durable-running-connection",
      attemptId: "durable-running-attempt",
    });
    await expect(plane.cancelSessionDurable("durable-3")).resolves.toMatchObject({
      ok: true,
      session: { status: "cancelled" },
    });
  });

  it("keeps a running superseded session locked until the daemon stops", () => {
    const messages: unknown[] = [];
    const plane = new ControlPlane({
      idFactory: () => "running",
      now: () => "2026-01-01T00:00:00.000Z",
      onHostMessage: (_hostId, message) => messages.push(message),
    });
    seedBaseCommand(plane);
    plane.createSession(baseSessionBody({ concurrencyId: "kr" }));
    Object.assign(plane.state.sessions.get("running")!, {
      status: "running",
      hostId: "host-r",
      worktreeId: "worktree-r",
      attemptId: "attempt-running",
    });
    setDurableReadStorage(plane.state, { putSession: async () => {} });
    supersedeSession(plane.state, "running", "replace running");
    expect(messages).toEqual([
      { type: "session:cancel", sessionId: "running", attemptId: "attempt-running" },
    ]);
  });

  it("persists a terminal status before releasing its concurrency lock", async () => {
    let resolveTerminalPut: (() => void) | undefined;
    const terminalPut = new Promise<void>((resolve) => {
      resolveTerminalPut = resolve;
    });
    const sessions = new Map<string, import("./db/types.ts").SessionRecord>();
    const locks = new Map<string, string>();
    const plane = new ControlPlane({
      idFactory: (() => {
        let id = 0;
        return () => `session-${++id}`;
      })(),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    seedBaseCommand(plane);
    setDurableReadStorage(plane.state, {
      createSession: async (session: import("./db/types.ts").SessionRecord) => {
        const owner = session.concurrencyId ? locks.get(session.concurrencyId) : undefined;
        if (owner) return { created: false, session: sessions.get(owner)! };
        sessions.set(session.id, { ...session });
        if (session.concurrencyId) locks.set(session.concurrencyId, session.id);
        return { created: true, session };
      },
      putSession: async (session: import("./db/types.ts").SessionRecord) => {
        if (session.status === "completed") await terminalPut;
        sessions.set(session.id, { ...session });
      },
      releaseConcurrencyLock: async (concurrencyId: string, sessionId: string) => {
        if (locks.get(concurrencyId) === sessionId) locks.delete(concurrencyId);
      },
    });
    const body = baseSessionBody({ concurrencyId: "terminal-lock" });

    const first = await plane.createSessionDurable(body);
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) return;
    plane.forceStatus(first.session.id, "completed");

    await expect(plane.createSessionDurable(body)).resolves.toMatchObject({
      ok: true,
      created: false,
      session: { id: first.session.id, status: "queued" },
    });
    resolveTerminalPut!();
    await plane.settleStorage();
    await expect(plane.createSessionDurable(body)).resolves.toMatchObject({
      ok: true,
      created: true,
    });
  });
});
