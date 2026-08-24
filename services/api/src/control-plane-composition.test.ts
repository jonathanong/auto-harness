import { describe, expect, it } from "vitest";

import { ControlPlane, ControlPlaneBase } from "./control-plane.ts";

describe("composed control-plane services", () => {
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
});
