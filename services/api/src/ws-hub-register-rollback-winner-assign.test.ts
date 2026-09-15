import { describe, expect, it } from "vitest";
import type WebSocket from "ws";

import { ControlPlane } from "./control-plane.ts";
import { createWsDelivery } from "./ws-hub.ts";
import {
  claimUnackedOnWorktree,
  expectFailedReplace,
  installUnpublishedWinner,
  loseSessionAfterValidation,
} from "../test-helpers/control-plane-register-rollback-test-helpers.ts";
import { baseSessionBody, seedBaseCommand } from "../test-helpers/control-plane-test-helpers.ts";

describe("storage-less register rollback winner socket assignment", () => {
  it("delivers the requeued assign on the published winner, not the closing loser", async () => {
    const plane = new ControlPlane({ idFactory: () => "claimed" });
    seedBaseCommand(plane);
    plane.createRepository({ id: "r", name: "r", url: "https://example.test/r.git" });
    const host = plane.registerHost({
      hostId: "h",
      worktrees: [{ id: "w", name: "w", repositoryId: "r", path: "/w", labels: [] }],
      commandProfiles: [],
    });
    if (!host.ok) throw new Error(host.error);
    plane.state.sessions.set("s", {
      id: "s",
      repositoryId: "r",
      prompt: "p",
      targetLabel: "t",
      timeout: 1,
      priority: 0,
      requiredLabels: [],
      onConflict: "queue",
      status: "running",
      queueShard: 0,
      createdAt: "t",
      hostId: "h",
      worktreeId: "w",
      ackReceivedAt: "t",
      primaryCommandStartState: "pending",
      reconnectDeadlineAt: "2000-01-01T00:00:00.000Z",
    });
    plane.state.worktrees.set("w", {
      id: "w",
      name: "w",
      hostId: "h",
      repositoryId: "r",
      path: "/w",
      labels: [],
      status: "busy",
      online: true,
      currentSessionId: "s",
    });
    const created = plane.createSession(baseSessionBody({ repositoryId: "r" }));
    if (!created.ok) throw new Error(created.error);

    const loser = fakeSocket();
    const winner = fakeSocket();
    const hostSockets = new Map<string, WebSocket>([["h", loser as unknown as WebSocket]]);
    plane.setOnHostMessage(createWsDelivery(hostSockets));

    loseSessionAfterValidation(plane, "s", () => {
      installUnpublishedWinner(plane, "winner", "w-idle");
      claimUnackedOnWorktree(plane, "claimed", "w2");
    });
    await expectFailedReplace(plane, ["w", "w2"]);
    expect(plane.getSession("claimed")).toMatchObject({ status: "queued" });
    expect(parsed(loser.sent).some((message) => message.type === "session:assign")).toBe(false);

    loser.readyState = 2;
    hostSockets.set("h", winner as unknown as WebSocket);
    plane.state.pendingHostSocketPublish.delete("winner");
    await plane.requestAssignment();

    expect(parsed(winner.sent)).toEqual([
      expect.objectContaining({
        type: "session:assign",
        sessionId: "claimed",
        worktreeId: "w-idle",
      }),
    ]);
    expect(parsed(loser.sent).some((message) => message.type === "session:assign")).toBe(false);
    expect(plane.getSession("claimed")).toMatchObject({
      status: "running",
      hostId: "h",
      worktreeId: "w-idle",
    });
  });
});

function fakeSocket() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

function parsed(frames: readonly string[]): Array<Record<string, unknown>> {
  return frames.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}
