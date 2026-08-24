import { describe, expect, it, vi } from "vitest";

import { createControlPlaneState } from "./control-plane-state.ts";
import {
  confirmScheduledReconnect,
  reclaimScheduledReconnect,
  requeueOmittedScheduled,
  restoreScheduledReconnects,
} from "./control-plane-reconnect-scheduled.ts";
import type { SessionRecord } from "./db/types.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function session(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "s",
    repositoryId: "repo",
    prompt: "run",
    commandId: "cmd",
    targetLabel: "cmd",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue",
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    source: "schedule",
    hostId: "host",
    attemptId: "attempt",
    assignmentConnectionId: "old",
    mainCheckoutLease: true,
    ackReceivedAt: NOW,
    ...over,
  };
}

function state() {
  return createControlPlaneState({ now: () => NOW, reconnectGraceMs: 100 });
}

describe("scheduled reconnect branch coverage", () => {
  it("rejects invalid confirmations and accepts local confirmation", async () => {
    const current = state();
    const row = session();
    expect(await confirmScheduledReconnect(current, row, "host", undefined)).toBe(false);
    expect(
      await confirmScheduledReconnect(current, { ...row, ackReceivedAt: undefined }, "host", "new"),
    ).toBe(false);
    expect(
      await confirmScheduledReconnect(current, { ...row, status: "queued" }, "host", "new"),
    ).toBe(false);
    current.mainCheckoutLeases.set("host\0repo", { sessionId: "s", connectionId: "old" });
    expect(await confirmScheduledReconnect(current, row, "host", "new")).toBe(true);
    expect(current.mainCheckoutLeases.get("host\0repo")?.connectionId).toBe("new");
    expect(current.sessions.get("s")).toMatchObject({ assignmentConnectionId: "new" });
    expect(current.sessions.get("s")).not.toHaveProperty("reconnectDeadlineAt");
  });

  it("uses durable confirmation, including rejected and nonmatching local leases", async () => {
    const current = state();
    const row = session({ reconnectDeadlineAt: "deadline" });
    let accepted = false;
    current.storage = {
      confirmMainCheckoutReconnect: async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          oldConnectionId: "old",
          connectionId: "new",
          deadlineAt: "deadline",
        });
        return accepted;
      },
    } as never;
    expect(await confirmScheduledReconnect(current, row, "host", "new")).toBe(false);
    accepted = true;
    current.mainCheckoutLeases.set("host\0repo", { sessionId: "other", connectionId: "old" });
    expect(await confirmScheduledReconnect(current, row, "host", "new")).toBe(true);
    expect(current.mainCheckoutLeases.get("host\0repo")).toMatchObject({
      sessionId: "other",
      connectionId: "old",
    });
  });

  it("requeues omitted sessions through both local and storage paths", async () => {
    const local = state();
    const row = session();
    local.sessions.set("s", row);
    local.mainCheckoutLeases.set("host\0repo", { sessionId: "s", connectionId: "old" });
    const requeued: string[] = [];
    await requeueOmittedScheduled(local, "host", new Set(), requeued);
    expect(requeued).toEqual(["s"]);
    expect(local.sessions.get("s")).toMatchObject({ status: "queued", hostId: null });
    expect(local.mainCheckoutLeases.has("host\0repo")).toBe(false);

    const durable = state();
    const calls: Record<string, unknown>[] = [];
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    durable.storage = {
      listSessionsByHost: async () => [
        row,
        session({ id: "reported" }),
        session({ id: "no-lease", mainCheckoutLease: undefined }),
        session({ id: "no-connection", assignmentConnectionId: undefined }),
      ],
      releaseMainCheckoutSession: async (input: Record<string, unknown>) => {
        calls.push(input);
        return input.sessionId !== "reported";
      },
      releaseLegacyHostAssignment,
    } as never;
    const durableRequeued: string[] = [];
    await requeueOmittedScheduled(durable, "host", new Set(["reported"]), durableRequeued);
    expect(calls).toHaveLength(1);
    expect(durableRequeued).toEqual(["s"]);
    expect(releaseLegacyHostAssignment).toHaveBeenCalledWith({
      sessionId: "s",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "old",
    });
  });

  it("restores confirmed reconnects in reverse order and skips unusable entries", async () => {
    const current = state();
    const first = session({ id: "first", assignmentConnectionId: "old-1" });
    const second = session({
      id: "second",
      assignmentConnectionId: "old-2",
      reconnectDeadlineAt: "old-deadline",
    });
    const calls: Record<string, unknown>[] = [];
    current.storage = {
      restoreMainCheckoutReconnect: async (input: Record<string, unknown>) => {
        calls.push(input);
        return input.sessionId !== "first";
      },
    } as never;
    await restoreScheduledReconnects(current, "host", "new", [
      { session: first },
      { session: { ...second, assignmentConnectionId: undefined } },
      { session: second },
    ]);
    expect(calls.map((call) => call.sessionId)).toEqual(["second", "first"]);
    expect(current.sessions.get("second")).toMatchObject({ reconnectDeadlineAt: "old-deadline" });
    expect(current.sessions.has("first")).toBe(false);
  });

  it("reclaims with durable and local release outcomes", async () => {
    const invalid = state();
    expect(
      await reclaimScheduledReconnect(invalid, session({ assignmentConnectionId: undefined }), []),
    ).toBe(false);
    const current = state();
    current.mainCheckoutLeases.set("host\0repo", { sessionId: "s", connectionId: "old" });
    const requeued: string[] = [];
    expect(await reclaimScheduledReconnect(current, session(), requeued)).toBe(true);
    expect(requeued).toEqual(["s"]);

    const durable = state();
    durable.storage = {
      releaseMainCheckoutSession: async () => false,
    } as never;
    const noChange: string[] = [];
    expect(await reclaimScheduledReconnect(durable, session(), noChange)).toBe(true);
    expect(noChange).toEqual([]);

    const durableSuccess = state();
    const releaseLegacyHostAssignment = vi.fn(async () => false);
    durableSuccess.storage = {
      releaseMainCheckoutSession: async () => true,
      releaseLegacyHostAssignment,
    } as never;
    const success = [] as string[];
    expect(await reclaimScheduledReconnect(durableSuccess, session(), success)).toBe(true);
    expect(success).toEqual(["s"]);
    expect(releaseLegacyHostAssignment).toHaveBeenCalledWith({
      sessionId: "s",
      attemptId: "attempt",
      hostId: "host",
      connectionId: "old",
    });
  });
});
