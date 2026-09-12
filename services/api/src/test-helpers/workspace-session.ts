import type { HostWireMessage } from "@auto-harness/shared";

import { ControlPlane } from "../control-plane.ts";

export function workspacePlane() {
  const messages: HostWireMessage[] = [];
  let sessionId = 0;
  const plane = new ControlPlane({
    idFactory: () => `session-${++sessionId}`,
    attemptIdFactory: () => `attempt-${sessionId}`,
    connectionIdFactory: () => "connection-1",
    workspacePoolIdFactory: () => "pool-1",
    now: () => "2026-09-12T00:00:00.000Z",
    shardCount: 1,
    onHostMessage: (_hostId, message) => messages.push(message),
  });
  plane.createCommand({ id: "command-1", name: "codex", argv: ["codex"], providerId: null });
  const pool = plane.createWorkspacePool({
    name: "general",
    setupProfiles: [{ id: "node", name: "Node", script: "pnpm install" }],
    defaultSetupProfileId: "node",
    destroyWorkspaceAfter: false,
  });
  if (!pool.ok) throw new Error(pool.error);
  const inventory = plane.putHostInventory("host-1", {
    repositories: [],
    allowedRoots: ["/srv/workspaces"],
    workspacePools: [
      {
        workspacePoolId: "pool-1",
        slots: [{ id: "slot-1", name: "one", path: "/srv/workspaces/one" }],
      },
    ],
  });
  if (!inventory.ok) throw new Error(inventory.error);
  const host = plane.registerHost({
    hostId: "host-1",
    worktrees: [],
    capabilities: ["workspace-sessions"],
    workspacePools: inventory.config.workspacePools ?? [],
  });
  if (!host.ok) throw new Error(host.error);
  return { plane, messages };
}

export function createWorkspaceSession(plane: ControlPlane) {
  const created = plane.createSession({
    repositoryId: null,
    workspacePoolId: "pool-1",
    prompt: "inspect this directory",
    target: { commandId: "command-1" },
    fallbacks: [],
    queueTtlSeconds: 300,
    timeout: 60,
    priority: 0,
    type: "workspace",
    source: "api",
  });
  if (!created.ok) throw new Error(created.error);
  return created.session;
}
