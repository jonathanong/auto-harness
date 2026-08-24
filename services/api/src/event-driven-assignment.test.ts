import { HOST_PROTOCOL_VERSION } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { baseSessionBody, seedBaseCommand } from "./control-plane-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function readyPlane() {
  const plane = new ControlPlane({
    now: () => NOW,
    idFactory: (() => {
      let n = 0;
      return () => `sess-${++n}`;
    })(),
    shardCount: 1,
  });
  seedBaseCommand(plane);
  plane.seedWorktree({
    id: "wt-1",
    name: "wt-1",
    hostId: "host-1",
    repositoryId: "repo-1",
    path: "/wt-1",
    labels: [],
    status: "idle",
    online: true,
  });
  return plane;
}

describe("event-driven assignment", () => {
  it("assigns immediately after HTTP create without a scheduler sweep", async () => {
    const plane = readyPlane();
    const { handler } = createLocalApp({ plane });
    const created = await invokeHandler(handler, "POST", "/api/v1/sessions", baseSessionBody());
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ id: "sess-1", status: "queued", created: true });
    expect(plane.getSession("sess-1")).toMatchObject({
      status: "running",
      worktreeId: "wt-1",
      hostId: "host-1",
    });
  });

  it("assigns a queued session when a host registers", async () => {
    const plane = new ControlPlane({
      now: () => NOW,
      idFactory: () => "sess-1",
      shardCount: 1,
    });
    seedBaseCommand(plane);
    expect(plane.createSession(baseSessionBody()).ok).toBe(true);
    expect(plane.getSession("sess-1")?.status).toBe("queued");
    expect(
      (
        await plane.handleHostMessageDurable({
          type: "host:register",
          hostId: "host-1",
          worktrees: [
            { id: "wt-1", name: "wt-1", repositoryId: "repo-1", path: "/wt-1", labels: [] },
          ],
          protocolVersion: HOST_PROTOCOL_VERSION,
          runtime: { daemonVersion: "test", gitVersion: "2.36.0", gitReady: true },
        })
      ).ok,
    ).toBe(true);
    await plane.requestAssignment();
    expect(plane.getSession("sess-1")).toMatchObject({
      status: "running",
      worktreeId: "wt-1",
      hostId: "host-1",
    });
  });

  it("assigns immediately after HTTP resume", async () => {
    const plane = readyPlane();
    const { handler } = createLocalApp({ plane });
    expect(plane.createSession(baseSessionBody()).ok).toBe(true);
    const assigned = plane.assignQueued()[0]!.session;
    expect(
      plane.handleHostMessage({
        type: "session:ack",
        sessionId: assigned.id,
        worktreeId: assigned.worktreeId!,
        attemptId: assigned.attemptId!,
      }).ok,
    ).toBe(true);
    expect(
      plane.handleHostMessage({
        type: "session:status",
        sessionId: assigned.id,
        worktreeId: assigned.worktreeId!,
        attemptId: assigned.attemptId!,
        status: "completed",
      }).ok,
    ).toBe(true);
    const resumed = await invokeHandler(handler, "POST", `/api/v1/sessions/${assigned.id}/resume`);
    expect(resumed.status).toBe(201);
    expect(resumed.json).toMatchObject({ created: true, status: "queued" });
    const next = plane.listSessions().find((session) => session.id !== assigned.id);
    expect(next).toMatchObject({ status: "running", worktreeId: "wt-1" });
  });
});
