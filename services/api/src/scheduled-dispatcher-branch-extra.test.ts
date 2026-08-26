import { describe, expect, it } from "vitest";

import {
  buildRegisteredInventory,
  parseHostRegistrationRepositories,
} from "./control-plane-agent-registration.ts";
import { confirmReportedSession } from "./control-plane-reconnect-confirm.ts";
import { releaseScheduledLeaseLocal } from "./control-plane-scheduled-assign.ts";
import {
  buildProviderCatalog,
  resolveScheduledSessionTarget,
} from "./control-plane-session-target.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import { ControlPlane } from "./control-plane.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "fixed" },
    fallbacks: [],
    targetDisplayNames: ["target"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 10,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "queued",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    ...over,
  };
}

function inventory(state: ReturnType<typeof createControlPlaneState>) {
  state.hostInventories.set(
    "host",
    buildRegisteredInventory("host", [{ id: "repo", path: "/repo" }], [], [], NOW),
  );
}

describe("scheduled dispatcher branch coverage", () => {
  it("rejects every malformed registration entry shape", () => {
    for (const [input, message] of [
      [[null], "repositories[0] must contain id and path"],
      [[[]], "repositories[0] must contain id and path"],
      [[{ id: 1, path: "/repo" }], "repositories[0] must contain id and path"],
      [[{ id: "repo", path: 1 }], "repositories[0] must contain id and path"],
      [[{ id: "", path: "/repo" }], "repositories[0] id and path must be non-empty strings"],
      [[{ id: "repo", path: "" }], "repositories[0] id and path must be non-empty strings"],
    ] as const) {
      expect(() => parseHostRegistrationRepositories(input)).toThrow(message);
    }
  });

  it("covers scheduled target provider, command, and argv rejection branches", () => {
    const state = createControlPlaneState();
    const catalog = buildProviderCatalog(state);
    inventory(state);
    expect(resolveScheduledSessionTarget(state, catalog, session(), "host")).toBeNull();
    expect(
      resolveScheduledSessionTarget(state, catalog, session({ providerAccountId: "a" }), "host"),
    ).toBeNull();
    state.commands.set("empty", {
      id: "empty",
      name: "empty",
      argv: [],
      appendPrompt: false,
      providerId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(
      resolveScheduledSessionTarget(
        state,
        catalog,
        session({ target: { commandId: "empty" } }),
        "host",
      ),
    ).toBeNull();
    state.commands.set("fixed", {
      id: "fixed",
      name: "fixed",
      argv: ["tool", "run"],
      appendPrompt: false,
      providerId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(
      resolveScheduledSessionTarget(
        state,
        catalog,
        session({ target: { commandId: "fixed" } }),
        "host",
      ),
    ).toMatchObject({ resolvedArgv: ["tool", "run"], resumeSpec: { appendPrompt: false } });
  });

  it("releases only the exact local scheduled lease", () => {
    const state = createControlPlaneState();
    const running = session({
      status: "running",
      hostId: "host",
      assignmentConnectionId: "connection",
      mainCheckoutLease: true,
    });
    expect(releaseScheduledLeaseLocal(state, session({ mainCheckoutLease: true }))).toBe(false);
    expect(releaseScheduledLeaseLocal(state, running)).toBe(false);
    state.mainCheckoutLeases.set("host\0repo", { sessionId: "other", connectionId: "connection" });
    expect(releaseScheduledLeaseLocal(state, running)).toBe(false);
    state.mainCheckoutLeases.set("host\0repo", { sessionId: "s", connectionId: "other" });
    expect(releaseScheduledLeaseLocal(state, running)).toBe(false);
    state.mainCheckoutLeases.set("host\0repo", { sessionId: "s", connectionId: "connection" });
    expect(releaseScheduledLeaseLocal(state, running)).toBe(true);
    expect(state.mainCheckoutLeases).toEqual(new Map());
  });

  it("covers reconnect confirmation without storage and rejected durable confirmation", async () => {
    const state = createControlPlaneState();
    const worktree: WorktreeRecord = {
      id: "wt",
      name: "wt",
      hostId: "host",
      repositoryId: "repo",
      path: "/wt",
      labels: [],
      status: "busy",
      online: false,
      currentSessionId: "s",
    };
    const running = session({
      status: "running",
      type: "prompt",
      hostId: "host",
      worktreeId: "wt",
      ackReceivedAt: NOW,
      reconnectDeadlineAt: NOW,
    });
    expect(await confirmReportedSession(state, running, worktree, "host", undefined)).toBe(true);
    expect(state.sessions.get("s")?.reconnectDeadlineAt).toBeUndefined();
    state.storage = {} as never;
    expect(await confirmReportedSession(state, running, worktree, "host", undefined)).toBe(false);
  });

  it("routes host message and scheduler endpoint edge responses", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });
    expect((await invokeHandler(handler, "POST", "/api/v1/host/messages", {})).status).toBe(400);
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/host/messages", {
          type: "session:ack",
          sessionId: "missing",
          worktreeId: null,
          attemptId: "attempt-missing",
        })
      ).status,
    ).toBe(410);
    expect((await invokeHandler(handler, "POST", "/api/v1/scheduler/ack-deadlines")).json).toEqual({
      requeued: [],
    });
    expect((await invokeHandler(handler, "POST", "/api/v1/scheduler/reclaim-stale")).json).toEqual({
      reclaimed: [],
    });
  });
});
