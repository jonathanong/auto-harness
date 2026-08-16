import { describe, expect, it } from "vitest";

import {
  buildRegisteredInventory,
  parseHostRegistrationRepositories,
} from "./control-plane-agent-registration.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { restoreScheduledReconnects } from "./control-plane-reconnect-scheduled.ts";
import { resolveSessionTargetArgv } from "./control-plane-session-target.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function scheduled(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "scheduled",
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["target"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 10,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    hostId: "host",
    worktreeId: null,
    assignmentConnectionId: "connection",
    assignmentSentAt: NOW,
    mainCheckoutLease: true,
    attemptId: "attempt",
    ...over,
  };
}

describe("scheduled final branch coverage", () => {
  it("parses a valid explicit inventory and retains an existing worktree setup script", () => {
    expect(
      parseHostRegistrationRepositories([{ id: "repo", path: "/repo", defaultBranch: "main" }]),
    ).toEqual([{ id: "repo", path: "/repo", defaultBranch: "main" }]);
    const previous = buildRegisteredInventory(
      "host",
      [{ id: "repo", path: "/old" }],
      [{ id: "wt", name: "wt", repositoryId: "repo", path: "/old/wt", labels: [] }],
      [],
      NOW,
    );
    previous.repositories[0]!.worktrees[0]!.setupScript = "setup";
    expect(
      buildRegisteredInventory(
        "host",
        [{ id: "repo", path: "/repo" }],
        [{ id: "wt", name: "wt", repositoryId: "repo", path: "/repo/wt", labels: [] }],
        [],
        NOW,
        previous,
      ).repositories[0]!.worktrees[0],
    ).toMatchObject({ setupScript: "setup" });
  });

  it("returns null for an empty ordinary command argv", () => {
    const state = createControlPlaneState();
    state.commands.set("empty", {
      id: "empty",
      name: "empty",
      argv: [],
      appendPrompt: true,
      providerId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(
      resolveSessionTargetArgv(
        state,
        { providers: {}, providerAccounts: {} },
        scheduled({ target: { commandId: "empty" }, type: "prompt" }),
        {
          id: "wt",
          name: "wt",
          hostId: "host",
          repositoryId: "repo",
          path: "/wt",
          labels: [],
          status: "idle",
          online: true,
        },
      ),
    ).toBeNull();
  });

  it("restores a local scheduled reconnect and ignores a declined durable restore", async () => {
    const state = createControlPlaneState({ now: () => NOW, reconnectGraceMs: 10 });
    const run = scheduled({ reconnectDeadlineAt: undefined, ackReceivedAt: NOW });
    await restoreScheduledReconnects(state, "host", "new", [{ session: run }]);
    expect(state.sessions.get(run.id)?.reconnectDeadlineAt).toBe("2026-01-01T00:00:00.010Z");
    state.storage = { restoreMainCheckoutReconnect: async () => false } as never;
    state.sessions.clear();
    await restoreScheduledReconnects(state, "host", "new", [{ session: run }]);
    expect(state.sessions).toEqual(new Map());
  });

  it("handles cancelled scheduled terminal reports when durable release loses or wins", async () => {
    const state = createControlPlaneState({ now: () => NOW });
    const run = scheduled({ status: "cancelled", completedAt: NOW });
    state.sessions.set(run.id, run);
    state.storage = { releaseMainCheckoutSession: async () => false } as never;
    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: run.id,
        worktreeId: null,
        attemptId: "attempt",
        status: "cancelled",
      }),
    ).resolves.toEqual({ ok: true });
    state.storage.releaseMainCheckoutSession = async () => true;
    state.mainCheckoutLeases.set("host\0repo", { sessionId: run.id, connectionId: "connection" });
    await expect(
      handleHostMessageDurable(state, {
        type: "session:status",
        sessionId: run.id,
        worktreeId: null,
        attemptId: "attempt",
        status: "cancelled",
        exitCode: 130,
        errorCode: "cancelled",
        errorMessage: "stopped",
        cliResumeRef: "ref",
      }),
    ).resolves.toEqual({ ok: true });
    expect(state.sessions.get(run.id)).toMatchObject({ status: "cancelled", exitCode: 130 });
  });

  it("covers scheduled terminal claim loss and successful retry release", async () => {
    const state = createControlPlaneState({ now: () => NOW, usageLimitRetryCeiling: 1 });
    const run = scheduled({ ackReceivedAt: NOW });
    state.sessions.set(run.id, run);
    state.storage = { releaseMainCheckoutSession: async () => false } as never;
    await handleHostMessageDurable(state, {
      type: "session:status",
      sessionId: run.id,
      worktreeId: null,
      attemptId: "attempt",
      status: "completed",
    });
    expect(state.sessions.get(run.id)?.status).toBe("running");
    state.storage.releaseMainCheckoutSession = async () => true;
    state.mainCheckoutLeases.set("host\0repo", { sessionId: run.id, connectionId: "connection" });
    await handleHostMessageDurable(state, {
      type: "session:status",
      sessionId: run.id,
      worktreeId: null,
      attemptId: "attempt",
      status: "failed",
      errorCode: "usage_limit",
    });
    expect(state.sessions.get(run.id)).toMatchObject({ status: "queued", retryCount: 1 });
  });
});
