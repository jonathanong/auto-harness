import { describe, expect, it } from "vitest";

import {
  clearAbandonedUsageLimitRetryFields,
  itemToSession,
  normalizeTargetDisplayNames,
  sessionToItem,
} from "./plane-storage-types.ts";
import {
  createdOrderKey,
  priorityOrderKey,
  repositoryPriorityOrderKey,
} from "../control-plane-ordering.ts";

describe("target display-name hydration", () => {
  it("migrates the legacy targetLabels attribute and removes storage-only keys", () => {
    expect(
      itemToSession({
        id: "legacy-session",
        targetLabels: ["Codex", "Echo"],
        statusShard: "queued#0",
        queueOrder: "order",
      }),
    ).toEqual({
      id: "legacy-session",
      targetDisplayNames: ["Codex", "Echo"],
    });
  });

  it("prefers the current field while removing a leftover legacy attribute", () => {
    expect(
      normalizeTargetDisplayNames({
        id: "mixed-session",
        targetLabels: ["Legacy"],
        targetDisplayNames: ["Current"],
      }),
    ).toEqual({ id: "mixed-session", targetDisplayNames: ["Current"] });
  });
});

describe("session priority list keys", () => {
  it("persists and strips durable list-only ordering attributes", () => {
    const session = {
      id: "s",
      repositoryId: "repo",
      status: "running" as const,
      queueShard: 1,
      priority: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never;
    const item = sessionToItem(session);
    expect(item.createdOrder).toBe(createdOrderKey(session));
    expect(item.priorityOrder).toBe(priorityOrderKey(session));
    expect(item.repositoryPriorityOrder).toBe(repositoryPriorityOrderKey("repo", session));
    expect(itemToSession(item)).not.toHaveProperty("priorityOrder");
    expect(itemToSession(item)).not.toHaveProperty("createdOrder");
    expect(itemToSession(item)).not.toHaveProperty("repositoryPriorityOrder");
  });
});

describe("abandoned usage-limit retry attributes", () => {
  it("strips leftover retryCount and retryAfter without requiring them on SessionRecord", () => {
    const session = { id: "s", retryCount: 2, retryAfter: "later" };
    clearAbandonedUsageLimitRetryFields(session);
    expect(session).toEqual({ id: "s" });
  });
});
