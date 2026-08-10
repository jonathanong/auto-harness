import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { offlineHostAndRequeueDurable } from "./control-plane-worktrees.ts";
import { offlineHostAndRequeue } from "./control-plane-worktrees.ts";
import type { SessionRecord, WorktreeRecord } from "./db/types.ts";

const session = (id: string, status: SessionRecord["status"], ack = false): SessionRecord => ({
  id,
  repositoryId: "r",
  prompt: "p",
  targetLabel: "t",
  timeout: 1,
  priority: 0,
  requiredLabels: [],
  onConflict: "queue",
  status,
  queueShard: 0,
  createdAt: "t",
  hostId: "h",
  worktreeId: `w-${id}`,
  ...(ack ? { ackReceivedAt: "t" } : {}),
});
const worktree = (
  id: string,
  currentSessionId: string | null,
  connectionId = "c",
): WorktreeRecord => ({
  id: `w-${id}`,
  name: id,
  hostId: "h",
  repositoryId: "r",
  path: `/${id}`,
  labels: [],
  status: currentSessionId ? "busy" : "idle",
  online: true,
  currentSessionId,
  connectionId,
});

describe("durable disconnect worktree reconciliation", () => {
  it("handles idle, missing, cancelled, acknowledged, unacknowledged, stale, and conditional-loss rows", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z", reconnectGraceMs: 5 });
    const rows = [
      worktree("idle", null),
      worktree("missing", "missing"),
      worktree("cancel", "cancel"),
      worktree("ack", "ack"),
      worktree("queue", "queue"),
      worktree("lose", "lose"),
      worktree("terminal", "terminal"),
      worktree("other", "other", "newer"),
    ];
    const sessions = new Map([
      ["cancel", session("cancel", "cancelled")],
      ["ack", session("ack", "running", true)],
      ["queue", session("queue", "running")],
      ["lose", session("lose", "running")],
      ["terminal", session("terminal", "completed")],
      ["other", session("other", "running")],
    ]);
    const calls: string[] = [];
    plane.state.storage = {
      listWorktreesByHost: async () => rows,
      getSession: async (id: string) => sessions.get(id) ?? null,
      getWorktree: async (id: string) => rows.find((row) => row.id === id) ?? null,
      setWorktreeOnlineFenced: async (id: string) => (calls.push(`offline:${id}`), true),
      releaseCancelledSessionWorktree: async (opts: { online: boolean }) => (
        calls.push(opts.online ? "cancel-online" : "cancel-offline"), true
      ),
      markReconnectPending: async (opts: { sessionId: string }) => (
        calls.push(`ack:${opts.sessionId}`), true
      ),
      tryRequeueSession: async (opts: { sessionId: string }) => {
        calls.push(`queue:${opts.sessionId}`);
        return opts.sessionId !== "lose";
      },
    } as never;
    const requeued = await offlineHostAndRequeueDurable(plane.state, "h", "c", "bye");
    expect(requeued).toEqual(["queue"]);
    expect(calls).toEqual(
      expect.arrayContaining([
        "offline:w-idle",
        "offline:w-missing",
        "cancel-offline",
        "ack:ack",
        "queue:queue",
        "queue:lose",
      ]),
    );
    expect(plane.state.sessions.get("queue")?.status).toBe("queued");
    expect(plane.state.worktrees.get("w-cancel")?.status).toBe("idle");
  });

  it("offlines a locally busy worktree even when it has no session reference", () => {
    const plane = new ControlPlane();
    plane.state.worktrees.set("empty", { ...worktree("empty", null), status: "busy" });
    expect(offlineHostAndRequeue(plane.state, "h", "bye")).toEqual([]);
    expect(plane.state.worktrees.get("empty")?.online).toBe(false);
  });
});
