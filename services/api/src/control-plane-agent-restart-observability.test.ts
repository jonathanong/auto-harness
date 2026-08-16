import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const FIRST = {
  instanceId: "123e4567-e89b-42d3-a456-426614174000",
  startedAt: "2026-08-11T00:00:00.000Z",
};
const SECOND = {
  instanceId: "223e4567-e89b-42d3-a456-426614174000",
  startedAt: "2026-08-12T00:00:00.000Z",
};
const ctx = createDynamoTestCtx("AgentRestartObservability");

function registration(daemonIdentity?: typeof FIRST) {
  return {
    hostId: "host",
    worktrees: [],
    repositories: [],
    replaceExisting: true,
    ...(daemonIdentity ? { daemonIdentity } : {}),
  };
}

describe("daemon restart observability", () => {
  it("baselines, ignores reconnects, detects new processes, and preserves telemetry on edits", () => {
    let now = "2026-08-11T00:00:01.000Z";
    let connection = 0;
    const plane = new ControlPlane({
      now: () => now,
      connectionIdFactory: () => `connection-${++connection}`,
    });

    expect(plane.registerHost(registration(FIRST)).ok).toBe(true);
    expect(plane.getHostInventory("host")).toMatchObject({
      daemonInstanceId: FIRST.instanceId,
      daemonStartedAt: FIRST.startedAt,
      restartCount: 0,
    });

    now = "2026-08-11T01:00:00.000Z";
    expect(
      plane.registerHost(registration({ ...FIRST, startedAt: "2026-08-11T00:30:00.000Z" })).ok,
    ).toBe(true);
    expect(plane.getHostInventory("host")).toMatchObject({
      daemonStartedAt: FIRST.startedAt,
      restartCount: 0,
    });

    now = "2026-08-12T00:00:01.000Z";
    expect(plane.registerHost(registration(SECOND)).ok).toBe(true);
    expect(plane.getHostInventory("host")).toMatchObject({
      daemonInstanceId: SECOND.instanceId,
      daemonStartedAt: SECOND.startedAt,
      restartCount: 1,
      lastRestartDetectedAt: now,
    });

    expect(plane.putHostInventory("host", { repositories: [] }).ok).toBe(true);
    expect(plane.registerHost(registration()).ok).toBe(true);
    expect(plane.getHostInventory("host")).toMatchObject({
      daemonInstanceId: SECOND.instanceId,
      daemonStartedAt: SECOND.startedAt,
      restartCount: 1,
      lastRestartDetectedAt: "2026-08-12T00:00:01.000Z",
    });
    expect(plane.listHosts()).toContainEqual(
      expect.objectContaining({
        hostId: "host",
        daemonStartedAt: SECOND.startedAt,
        restartCount: 1,
        lastRestartDetectedAt: "2026-08-12T00:00:01.000Z",
      }),
    );
  });

  it("returns restart observability from the hosts HTTP route", async () => {
    const plane = new ControlPlane({ now: () => "2026-08-12T00:00:01.000Z" });
    plane.state.hostInventories.set("offline-host", {
      hostId: "offline-host",
      repositories: [],
      providerAccounts: [],
      daemonInstanceId: SECOND.instanceId,
      daemonStartedAt: SECOND.startedAt,
      restartCount: 3,
      lastRestartDetectedAt: "2026-08-12T00:00:01.000Z",
      updatedAt: "2026-08-12T00:00:01.000Z",
    });
    const response = await invokeHandler(createLocalApp({ plane }).handler, "GET", "/api/v1/hosts");
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      items: [
        expect.objectContaining({
          hostId: "offline-host",
          online: false,
          daemonStartedAt: SECOND.startedAt,
          restartCount: 3,
          lastRestartDetectedAt: "2026-08-12T00:00:01.000Z",
        }),
      ],
    });
  });

  it("persists baseline and restart detection through Dynamo hydration and inventory edits", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    let connection = 0;
    // This worker exists before the baseline write and deliberately never
    // hydrates, reproducing a stale warm Lambda cache.
    const staleReplacement = new ControlPlane({
      storage: ctx.storage,
      now: () => "2026-08-12T00:00:01.000Z",
      connectionIdFactory: () => `restart-connection-${++connection}`,
    });
    const first = new ControlPlane({
      storage: ctx.storage,
      now: () => "2026-08-11T00:00:01.000Z",
      connectionIdFactory: () => `restart-connection-${++connection}`,
    });
    expect((await first.registerHostDurable(registration(FIRST))).ok).toBe(true);

    const afterBaseline = new ControlPlane({
      storage: ctx.storage,
      now: () => "2026-08-11T01:00:00.000Z",
      connectionIdFactory: () => `restart-connection-${++connection}`,
    });
    await afterBaseline.hydrateFromStorage();
    expect((await afterBaseline.putHostInventoryDurable("host", { repositories: [] })).ok).toBe(
      true,
    );
    expect((await afterBaseline.registerHostDurable(registration(FIRST))).ok).toBe(true);

    expect((await staleReplacement.registerHostDurable(registration(SECOND))).ok).toBe(true);

    const hydrated = new ControlPlane({ storage: ctx.storage });
    await hydrated.hydrateFromStorage();
    expect(hydrated.getHostInventory("host")).toMatchObject({
      daemonInstanceId: SECOND.instanceId,
      daemonStartedAt: SECOND.startedAt,
      restartCount: 1,
      lastRestartDetectedAt: "2026-08-12T00:00:01.000Z",
    });
    await expect(hydrated.listHostsDurable()).resolves.toContainEqual(
      expect.objectContaining({
        hostId: "host",
        daemonStartedAt: SECOND.startedAt,
        restartCount: 1,
        lastRestartDetectedAt: "2026-08-12T00:00:01.000Z",
      }),
    );
  });
});
