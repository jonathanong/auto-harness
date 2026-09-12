import { expect, it } from "vitest";

import {
  hostAssignmentOccupancyCount,
  hostHasAssignmentCapacity,
  providerAccountLeaseWriteOpts,
} from "./control-plane-provider-account-leases.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

it("counts only busy workspace slots on the requested host and preserves absent lease write options", () => {
  const state = createControlPlaneState();
  state.hostConnection.set("host", "connection");
  state.connections.set("connection", { maxConcurrentAssignments: 1 } as never);
  state.workspaceSlots.set("idle", {
    id: "idle",
    hostId: "host",
    workspacePoolId: "pool",
    name: "idle",
    path: "/idle",
    status: "idle",
    online: true,
  });
  state.workspaceSlots.set("elsewhere", {
    id: "elsewhere",
    hostId: "other",
    workspacePoolId: "pool",
    name: "elsewhere",
    path: "/other",
    status: "busy",
    online: true,
    currentSessionId: "other-session",
  });
  state.workspaceSlots.set("busy", {
    id: "busy",
    hostId: "host",
    workspacePoolId: "pool",
    name: "busy",
    path: "/busy",
    status: "busy",
    online: true,
  });
  state.sessions.set("workspace-session", {
    id: "workspace-session",
    repositoryId: "",
    workspaceSlotId: "busy",
    prompt: "inspect",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: [],
    queueTtlSeconds: 60,
    queueExpiresAt: "later",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: "now",
    worktreeId: null,
    hostId: "host",
  });
  expect(hostAssignmentOccupancyCount(state, "host")).toBe(1);
  expect(hostHasAssignmentCapacity(state, "host")).toBe(false);
  expect(providerAccountLeaseWriteOpts({})).toEqual({});
});
