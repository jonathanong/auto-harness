import { describe, expect, it } from "vitest";

import { listQueuedSessionsDurableForMetric } from "./control-plane-durable-read-catalog.ts";
import { createControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";

const session = {
  id: "s",
  repositoryId: "repo",
  prompt: "run",
  target: { commandId: "cmd" },
  fallbacks: [],
  targetDisplayNames: ["cmd"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2099-01-01T00:00:00.000Z",
  timeout: 30,
  priority: 0,
  requiredLabels: [],
  onConflict: "queue",
  status: "queued",
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
} as SessionRecord;

describe("queued session metric reads", () => {
  it("lists in-memory queued sessions when durable storage is unavailable", async () => {
    const state = createControlPlaneState({ shardCount: 1 });
    state.sessions.set("queued", { ...session, id: "queued" });
    state.sessions.set("running", { ...session, id: "running", status: "running" });
    await expect(listQueuedSessionsDurableForMetric(state)).resolves.toEqual([
      expect.objectContaining({ id: "queued" }),
    ]);
  });
});
