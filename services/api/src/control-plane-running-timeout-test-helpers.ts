import { expect } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";

export const RUNNING_TIMEOUT_NOW = "2026-08-21T16:19:39.015Z";
export const RUNNING_TIMEOUT_SECONDS = 900;

export function startAcknowledgedRunning(plane: ControlPlane): {
  sessionId: string;
  worktreeId: string;
} {
  seedBaseCommand(plane);
  plane.registerHost({
    hostId: "host",
    worktrees: [{ id: "wt", name: "wt", repositoryId: "repo-1", path: "/wt", labels: [] }],
  });
  const created = plane.createSession(baseSessionBody({ timeout: RUNNING_TIMEOUT_SECONDS }));
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error);
  plane.assignQueued();
  const session = plane.getSession(created.session.id)!;
  plane.handleHostMessage({
    type: "session:ack",
    sessionId: session.id,
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
  });
  expect(plane.getSession(session.id)?.status).toBe("running");
  return { sessionId: session.id, worktreeId: session.worktreeId! };
}

export function runningDeadlineMs(plane: ControlPlane, sessionId: string): number {
  return Date.parse(plane.getSession(sessionId)!.startedAt!) + RUNNING_TIMEOUT_SECONDS * 1000;
}
