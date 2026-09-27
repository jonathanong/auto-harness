import { expect, it } from "vitest";
import { createTestControlPlaneState } from "../test-helpers/reporting-control-plane.ts";
import { session } from "../test-helpers/blackboard-reporting-fixtures.ts";
import { settleStorage } from "./control-plane-state.ts";
import { handleHostMessage } from "./control-plane-messages.ts";

const command = {
  type: "session:command-start" as const,
  sessionId: "session",
  worktreeId: "worktree",
  attemptId: "attempt",
};

function simulated(authorization: Promise<boolean>) {
  const messages: unknown[] = [];
  const state = createTestControlPlaneState({
    blackboardReporting: { authorize: () => authorization } as never,
    onHostMessage: (_hostId, message) => messages.push(message),
  });
  state.sessions.set("session", session());
  state.hostConnection.set("host", "connection");
  expect(handleHostMessage(state, command, "connection")).toEqual({ ok: true });
  return { state, messages };
}

it("waits for online proof and fences the simulated command against a replaced connection", async () => {
  const pending = Promise.withResolvers<boolean>();
  const { state, messages } = simulated(pending.promise);
  expect(messages).toEqual([]);
  state.hostConnection.set("host", "replacement");
  pending.resolve(true);
  await settleStorage(state);
  expect(messages).toEqual([]);
  expect(state.sessions.get("session")?.primaryCommandStartState).toBe("pending");
});

it("marks denied proof visibly and leaves execution unauthorized in the explicit test simulation", async () => {
  const { state, messages } = simulated(Promise.resolve(false));
  await settleStorage(state);
  expect(state.sessions.get("session")).toMatchObject({
    reportingAdmissionBlocked: true,
    primaryCommandStartState: "pending",
  });
  expect(messages).toEqual([]);
});

it("swallows a reporting transport rejection without notifying the simulated host", async () => {
  const { state, messages } = simulated(Promise.reject(new Error("reporting unavailable")));
  await settleStorage(state);
  expect(messages).toEqual([]);
  expect(state.sessions.get("session")?.primaryCommandStartState).toBe("pending");
});
