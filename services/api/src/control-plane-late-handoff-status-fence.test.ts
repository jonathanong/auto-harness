import { expect, it, vi } from "vitest";

import { setDurableReadStorage } from "../test-helpers/control-plane-durable-read-test-helpers.ts";
import { handleHostMessageDurable } from "./control-plane-messages.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

it("does not reuse a deferred handoff for a different terminal report from the same attempt", async () => {
  const state = createControlPlaneState({ now: () => "2026-01-01T00:00:00.000Z" });
  const session: SessionRecord = {
    id: "session",
    repositoryId: "repo",
    prompt: "run",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "timed_out",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    worktreeId: null,
    hostId: null,
    timedOutHostId: "host",
    attemptId: "attempt",
    terminalHookHandoff: {
      handoffId: "failed-handoff",
      attemptId: "attempt",
      hostId: "host",
      repositoryId: "repo",
      worktreeId: null,
      status: "failed",
      expiresAt: "2026-01-02T00:00:00.000Z",
    },
  };
  const finishSession = vi.fn(async () => true);
  setDurableReadStorage(state, { getSession: async () => session, finishSession });

  await expect(
    handleHostMessageDurable(
      state,
      {
        type: "session:status",
        sessionId: "session",
        worktreeId: null,
        attemptId: "attempt",
        status: "cancelled",
        deferTerminalHookResult: true,
      },
      undefined,
      false,
      false,
      7,
    ),
  ).resolves.toEqual({
    ok: true,
    sessionStatusAcknowledged: { sessionId: "session", attemptId: "attempt" },
  });
  expect(finishSession).not.toHaveBeenCalled();
});
