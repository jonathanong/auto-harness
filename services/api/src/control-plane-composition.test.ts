import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";

import { ControlPlane, ControlPlaneBase } from "./control-plane.ts";
import { createControlPlaneState, sessionForPersistence, toPublic } from "./control-plane-state.ts";

describe("composed control-plane services", () => {
  it("defaults host registration protocolVersion through the composed facade", () => {
    const plane = new ControlPlane({ connectionIdFactory: () => "connection" });
    expect(plane.registerHost({ hostId: "host", worktrees: [], commandProfiles: [] })).toEqual({
      ok: true,
      connectionId: "connection",
    });
    expect(plane.state.connections.get("connection")?.protocolVersion).toBe(HOST_PROTOCOL_VERSION);
    expect(plane.state.connections.get("connection")?.negotiatedProtocolVersion).toBe(
      HOST_PROTOCOL_VERSION,
    );
  });

  it("exposes domain services and keeps facade method compatibility", async () => {
    const plane = new ControlPlane();
    expect(plane.sessions.state).toBe(plane.state);
    expect(plane.scheduling.state).toBe(plane.state);
    expect(plane.hosts.state).toBe(plane.state);
    expect(plane.catalog.state).toBe(plane.state);
    expect(plane.audit.state).toBe(plane.state);
    expect(plane.repositories.state).toBe(plane.state);
    expect(plane.integrations.state).toBe(plane.state);
    expect(plane.listSessions()).toEqual([]);
    expect(plane.sessions.listSessions()).toEqual([]);
    expect(plane.listSchedules()).toEqual([]);
    expect(plane.scheduling.listSchedules()).toEqual([]);
    expect(plane.listHosts()).toEqual([]);
    expect(plane.listProviders()).toEqual([]);
    expect(plane.listRepositories()).toEqual([]);
    await expect(plane.getSlackIntegration()).resolves.toBeNull();
    await expect(plane.integrations.getSlackIntegration()).resolves.toBeNull();
    expect(new ControlPlaneBase().listSessionsPage().items).toEqual([]);
  });

  it("does not expose sparse storage keys in public session responses", () => {
    const state = createControlPlaneState();
    const session = {
      id: "session",
      repositoryId: "repo",
      prompt: "prompt",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "2026-01-01T00:01:00.000Z",
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running" as const,
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      activeHostId: "host",
      activeHostOrder: "2026-01-01T00:00:00.000Z#session",
    };

    expect(toPublic(state, session)).not.toHaveProperty("activeHostId");
    expect(toPublic(state, session)).not.toHaveProperty("activeHostOrder");
    expect(
      sessionForPersistence({ ...session, status: "completed", completedAt: session.createdAt }),
    ).not.toHaveProperty("activeHostId");
    expect(
      sessionForPersistence({ ...session, status: "completed", completedAt: session.createdAt }),
    ).not.toHaveProperty("activeHostOrder");
    const withResult = {
      ...session,
      result: { summary: "done", summarySource: "harness" as const },
    };
    expect(toPublic(state, withResult)).toHaveProperty("result.summary", "done");
    expect(toPublic(state, withResult, false)).not.toHaveProperty("result");
  });
});
