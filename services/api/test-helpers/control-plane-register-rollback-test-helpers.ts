import type { HostWireMessage } from "@auto-harness/shared";
import { expect } from "vitest";

import { ControlPlane } from "../src/control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

export const ROLLBACK_NOW = "2026-01-01T00:00:00.000Z";

export function durableRunning(id: string, worktreeId: string) {
  return {
    id,
    repositoryId: "r",
    prompt: "p",
    targetLabel: "t",
    timeout: 1,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue" as const,
    status: "running" as const,
    queueShard: 0,
    createdAt: "t",
    hostId: "h",
    worktreeId,
    ackReceivedAt: "t",
    primaryCommandStartState: "pending" as const,
    reconnectDeadlineAt: "2000-01-01T00:00:00.000Z",
  };
}

export function durableWorktree(id: string, sessionId: string | null) {
  return {
    id,
    name: id,
    hostId: "h",
    repositoryId: "r",
    path: `/${id}`,
    labels: [],
    status: (sessionId ? "busy" : "idle") as "busy" | "idle",
    online: true,
    currentSessionId: sessionId,
  };
}

export function loseSessionAfterValidation(
  plane: ControlPlane,
  sessionId: string,
  onLost?: () => void,
) {
  let reads = 0;
  const origGet = plane.state.sessions.get.bind(plane.state.sessions);
  plane.state.sessions.get = (id: string) => {
    const current = origGet(id);
    if (id !== sessionId || !current) return current;
    reads += 1;
    if (reads > 1) onLost?.();
    return reads === 1 ? current : { ...current, status: "queued" as const };
  };
}

function newRollbackPlane() {
  let connectionSeq = 0;
  const plane = new ControlPlane({
    now: () => ROLLBACK_NOW,
    idFactory: () => "claimed",
    connectionIdFactory: () => `c${++connectionSeq}`,
  });
  seedBaseCommand(plane);
  return plane;
}

function registerRepoWorktrees(
  plane: ControlPlane,
  hostId: string,
  worktreeIds: readonly string[],
) {
  return plane.registerHost({
    hostId,
    worktrees: worktreeIds.map((id) => ({
      id,
      name: id,
      repositoryId: "r",
      path: `/${id}`,
      labels: [],
    })),
    commandProfiles: [],
  });
}

function seedReportedRunning(plane: ControlPlane) {
  plane.state.sessions.set("s", { ...durableRunning("s", "w") });
  plane.state.worktrees.set("w", durableWorktree("w", "s"));
}

function seedQueuedClaim(plane: ControlPlane) {
  const created = plane.createSession(baseSessionBody({ repositoryId: "r" }));
  if (!created.ok) throw new Error(created.error);
}

function collectHostMessages(plane: ControlPlane) {
  const messages: Array<{ hostId: string; message: HostWireMessage }> = [];
  plane.setOnHostMessage((hostId, message) => messages.push({ hostId, message }));
  return messages;
}

export function readyRollbackPlane() {
  const plane = newRollbackPlane();
  const host = registerRepoWorktrees(plane, "h", ["w"]);
  if (!host.ok) throw new Error(host.error);
  const capacity = registerRepoWorktrees(plane, "cap", ["cap-w"]);
  if (!capacity.ok) throw new Error(capacity.error);
  seedReportedRunning(plane);
  seedQueuedClaim(plane);
  return { plane, messages: collectHostMessages(plane) };
}

export function installUnpublishedWinner(
  plane: ControlPlane,
  connectionId: string,
  idleWorktreeId: string,
) {
  plane.state.connections.set(connectionId, {
    connectionId,
    type: "host",
    hostId: "h",
    connectedAt: ROLLBACK_NOW,
    lastHeartbeatAt: ROLLBACK_NOW,
    repositoryIds: ["r"],
    capabilities: [],
    negotiatedProtocolVersion: 1,
    runtime: { daemonVersion: "test/seeded", gitVersion: "2.36.0", gitReady: true },
  });
  plane.state.hostConnection.set("h", connectionId);
  plane.state.pendingHostSocketPublish.add(connectionId);
  plane.state.worktrees.set(idleWorktreeId, durableWorktree(idleWorktreeId, null));
  const inventory = plane.state.hostInventories.get("h");
  if (!inventory) return;
  plane.state.hostInventories.set("h", {
    ...inventory,
    repositories: inventory.repositories.map((repo) => ({
      ...repo,
      worktrees: [
        ...repo.worktrees.filter((wt) => wt.id === "w"),
        {
          ...(repo.worktrees[0] ?? { labels: [] }),
          id: idleWorktreeId,
          name: idleWorktreeId,
          path: `/${idleWorktreeId}`,
        },
      ],
    })),
  });
}

export function claimUnackedOnWorktree(plane: ControlPlane, sessionId: string, worktreeId: string) {
  const session = plane.state.sessions.get(sessionId);
  if (!session) throw new Error(`missing ${sessionId}`);
  session.status = "running";
  session.hostId = "h";
  session.worktreeId = worktreeId;
  delete session.ackReceivedAt;
  plane.state.worktrees.set(worktreeId, durableWorktree(worktreeId, sessionId));
}

export async function expectFailedReplace(plane: ControlPlane, worktreeIds: readonly string[]) {
  await expect(
    plane.registerHostDurable({
      hostId: "h",
      worktrees: worktreeIds.map((id) => ({
        id,
        name: id,
        repositoryId: "r",
        path: `/${id}`,
        labels: [],
      })),
      commandProfiles: [],
      runningSessions: ["s"],
      replaceExisting: true,
    }),
  ).resolves.toEqual({
    ok: false,
    error: "reported running session lost reconnect reconciliation",
  });
}
