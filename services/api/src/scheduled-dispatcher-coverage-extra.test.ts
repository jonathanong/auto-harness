import { describe, expect, it } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import { ControlPlane } from "./control-plane.ts";
import {
  buildRegisteredInventory,
  parseHostRegistrationRepositories,
  resolveRegisteredRepositories,
} from "./control-plane-agent-registration.ts";
import {
  buildProviderCatalog,
  resolveScheduledSessionTarget,
} from "./control-plane-session-target.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function scheduled(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "scheduled",
    repositoryId: "repo",
    prompt: "maintenance",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetLabels: ["cmd"],
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

describe("scheduled dispatcher coverage edges", () => {
  it("parses registration variants and preserves previous inventory details", () => {
    expect(parseHostRegistrationRepositories(undefined)).toBeUndefined();
    expect(() => parseHostRegistrationRepositories({})).toThrow("repositories must be an array");
    expect(() =>
      parseHostRegistrationRepositories([{ id: "r", path: "/r", defaultBranch: 1 }]),
    ).toThrow("defaultBranch must be a string");
    const previous = buildRegisteredInventory(
      "host",
      [{ id: "repo", path: "/old", defaultBranch: "trunk" }],
      [{ id: "wt", name: "wt", repositoryId: "repo", path: "/old/wt", labels: ["x"] }],
      {},
      [],
      NOW,
    );
    const repos = resolveRegisteredRepositories(undefined, [], previous);
    expect(repos).toEqual([{ id: "repo", path: "/old", defaultBranch: "trunk" }]);
    expect(
      buildRegisteredInventory("host", [{ id: "repo", path: "/new" }], [], {}, [], NOW, previous),
    ).toMatchObject({ repositories: [{ path: "/new", defaultBranch: "trunk", worktrees: [] }] });
  });

  it("resolves only eligible scheduled main-checkout provider targets", () => {
    const state = createControlPlaneState();
    state.commands.set("cmd", {
      id: "cmd",
      name: "cmd",
      argv: ["tool"],
      appendPrompt: true,
      providerId: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(
      resolveScheduledSessionTarget(state, buildProviderCatalog(state), scheduled(), "host"),
    ).toBeNull();
    state.hostInventories.set(
      "host",
      buildRegisteredInventory("host", [{ id: "repo", path: "/repo" }], [], {}, [], NOW),
    );
    expect(
      resolveScheduledSessionTarget(state, buildProviderCatalog(state), scheduled(), "host"),
    ).toMatchObject({
      resolvedArgv: ["tool", "maintenance"],
    });
    expect(
      resolveScheduledSessionTarget(
        state,
        buildProviderCatalog(state),
        scheduled({ target: { providerId: "missing" } }),
        "host",
      ),
    ).toBeNull();
  });

  it("requires a reported scheduled run to match its exact local lease", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "replacement" });
    const run = {
      ...scheduled({ status: "running", hostId: "host", worktreeId: null }),
      ackReceivedAt: NOW,
      assignmentConnectionId: "old",
      mainCheckoutLease: true,
    };
    plane.state.sessions.set(run.id, run);
    const register = () =>
      plane.registerHost({
        hostId: "host",
        worktrees: [],
        repositories: [{ id: "repo", path: "/repo", defaultBranch: "main" }],
        commandProfiles: [],
        runningSessions: [run.id],
        replaceExisting: true,
      });
    expect(register()).toEqual({
      ok: false,
      error: "running session scheduled is not owned by host host",
    });
    plane.state.mainCheckoutLeases.set("host\0repo", { sessionId: run.id, connectionId: "old" });
    expect(register()).toMatchObject({ ok: true, connectionId: "replacement" });
  });

  it("returns scheduled main-checkout assignments from the scheduler route", async () => {
    const plane = new ControlPlane({ idFactory: () => "run", now: () => NOW, shardCount: 1 });
    plane.createCommand({ id: "cmd", name: "cmd", argv: ["tool"], providerId: null });
    plane.registerHost({
      hostId: "host",
      worktrees: [],
      repositories: [{ id: "repo", path: "/repo", defaultBranch: "main" }],
      commandProfiles: [],
      capabilities: ["scheduled-main-checkout"],
    });
    plane.putSchedule({
      id: "schedule",
      repositoryId: "repo",
      name: "maintenance",
      target: { commandId: "cmd" },
      cron: "* * * * *",
      timeout: 10,
      nextRunAt: NOW,
    });
    plane.evaluateCron("2026-01-01T00:01:00.000Z");
    const { handler } = createLocalApp({ plane });
    const response = await invokeHandler(handler, "POST", "/api/v1/scheduler/assign");
    expect(response.json).toEqual({
      items: [{ sessionId: "run", worktreeId: null, hostId: "host" }],
    });
  });
});
