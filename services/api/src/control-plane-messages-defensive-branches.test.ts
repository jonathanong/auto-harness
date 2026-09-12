/* eslint-disable max-lines -- isolates two defensive durable lifecycle branches. */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./control-plane-lifecycle.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./control-plane-lifecycle.ts")>();
  return {
    ...actual,
    planSessionTransition: (
      _session: unknown,
      event: { type: string; status?: string; cliResumeRef?: string },
      context: { source?: string },
    ) =>
      event.type === "status" && event.status === "completed" && !event.cliResumeRef
        ? { effects: [{ type: "reject", error: "defensive rejection" }] }
        : event.type === "status" && event.status === "completed"
          ? { effects: [{ type: "finish", status: "completed", completedAt: NOW }] }
          : event.type === "status" && event.status === "cancelled" && context.source === "local"
            ? { effects: [] }
            : context.source === "local"
              ? { effects: [{ type: "requeue", reason: "disconnect" }] }
              : {
                  effects: [
                    { type: "cooldown", providerAccountId: "account", usageLimitedUntil: "later" },
                    { type: "requeue", reason: "usage_limit" },
                    { type: "reschedule", kind: "workspace" },
                  ],
                },
  };
});

vi.mock("./request-assignment.ts", () => ({ requestAssignment: async () => undefined }));

import { createControlPlaneState } from "./control-plane-state.ts";
import { handleHostMessage, handleHostMessageDurable } from "./control-plane-messages.ts";
import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: null,
    attemptId: "attempt",
    assignmentConnectionId: "connection",
    workspaceSlotId: "slot",
    resolvedRoute: {
      targetIndex: 0,
      commandId: "command",
      providerAccountId: "account",
      hostId: "host",
      worktreeId: null,
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      attemptId: "attempt",
    },
    type: "workspace",
    source: "api",
  };
}

describe("durable lifecycle defensive branches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a rejection effect from the durable transition planner", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const row = session();
    setDurableReadStorage(state, { getSession: async () => row });
    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: null,
        attemptId: row.attemptId!,
        status: "completed",
      }),
    ).resolves.toEqual({ ok: false, error: "defensive rejection" });
  });

  it("handles a cooldown plan without a loaded provider account", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const row = session();
    state.workspaceSlots.set("slot", {
      id: "slot",
      workspacePoolId: "pool",
      hostId: "host",
      name: "slot",
      path: "/workspace",
      status: "busy",
      online: true,
      retired: false,
      currentSessionId: row.id,
      connectionId: "connection",
      lastAssignedAt: null,
    });
    const storage = {
      getSession: async () => row,
      getProviderAccount: async () => undefined,
      requeueUsageLimitedWorkspaceSession: async () => true,
    };
    setDurableReadStorage(state, storage);
    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: null,
        attemptId: row.attemptId!,
        status: "failed",
        errorCode: "usage_limit",
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("handles a requeue plan that has no reschedule or finish effect", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const row = session();
    state.sessions.set(row.id, row);
    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: null,
        attemptId: row.attemptId!,
        status: "failed",
      }),
    ).toEqual({ ok: true });
  });

  it("handles a durable finish effect explicitly", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const row = session();
    state.sessions.set(row.id, row);
    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: null,
        attemptId: row.attemptId!,
        status: "completed",
        cliResumeRef: "finish",
      }),
    ).toEqual({ ok: true });
  });

  it("evaluates the terminal finish guard when no terminal effect is present", () => {
    const state = createControlPlaneState({ now: () => NOW });
    const row = session();
    state.sessions.set(row.id, row);
    expect(
      handleHostMessage(state, {
        type: "session:status",
        sessionId: row.id,
        worktreeId: null,
        attemptId: row.attemptId!,
        status: "cancelled",
      }),
    ).toEqual({ ok: true });
  });
});
