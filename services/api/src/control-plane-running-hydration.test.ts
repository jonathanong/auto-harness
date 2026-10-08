import { describe, expect, it, vi } from "vitest";

import { hydrateRunningSessions } from "./control-plane-durable-read-hydration.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

describe("durable running-session hydration", () => {
  it("reads the sparse operational membership instead of terminal status history", async () => {
    const state = createControlPlaneState({ shardCount: 1 });
    const running = {
      id: "active",
      status: "running",
      attemptId: "attempt",
      queueShard: 0,
      repositoryId: "repo",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as SessionRecord;
    const listOperationalSessions = vi.fn(async () => [running]);
    const listSessionsByStatus = vi.fn(() => {
      throw new Error("terminal history was queried");
    });
    const storage = { listOperationalSessions, listSessionsByStatus } as never;

    await expect(hydrateRunningSessions(state, storage)).resolves.toBe(true);
    expect(listOperationalSessions).toHaveBeenCalledWith(1);
    expect(listSessionsByStatus).not.toHaveBeenCalled();
    expect(state.sessions.get("active")).toMatchObject({ status: "running" });
  });
});
