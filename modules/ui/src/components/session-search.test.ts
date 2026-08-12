import { describe, expect, it } from "vitest";

import { sessionMatchesSearch, sessionSearchableText } from "./session-search.ts";

describe("session search projection", () => {
  it("projects every loaded session identity, label, route, source, and visible value", () => {
    const text = sessionSearchableText({
      id: "SESSION-ID",
      status: "RUNNING",
      repositoryId: "REPOSITORY-ID",
      repositoryName: "Repository Name",
      prompt: "Prompt Text",
      targetLabel: "Target Label",
      targetLabels: ["Primary Label", "Fallback Label"],
      target: { providerId: "Provider ID", commandId: "Command ID" },
      fallbacks: [{ providerId: "Fallback Provider", commandId: "Fallback Command" }, {}],
      queueExpiresAt: "Queue Expiry",
      resolvedProviderAccountId: "Resolved Account",
      resolvedCommandId: "Resolved Command",
      resolvedHostId: "Resolved Host",
      resolvedRoute: {
        targetIndex: 1,
        providerAccountId: "Route Account",
        commandId: "Route Command",
        hostId: "Route Host",
        worktreeId: "Route Worktree",
      },
      source: "SCHEDULE",
      priority: 0,
      requiredLabels: ["GPU Label"],
      concurrencyId: "Concurrency ID",
      hostId: "Assigned Host",
      createdAt: "Created Timestamp",
      startedAt: "Started Timestamp",
      completedAt: "Completed Timestamp",
      errorCode: "Queue Expired",
    });

    for (const expected of [
      "session-id",
      "running",
      "repository-id",
      "repository name",
      "prompt text",
      "target label",
      "primary label",
      "fallback label",
      "provider id",
      "command id",
      "fallback provider",
      "fallback command",
      "queue expiry",
      "resolved account",
      "resolved command",
      "resolved host",
      "target 2",
      "route account",
      "route command",
      "route host",
      "route worktree",
      "schedule",
      "0",
      "gpu label",
      "concurrency id",
      "assigned host",
      "created timestamp",
      "started timestamp",
      "completed timestamp",
      "queue expired",
    ]) {
      expect(text).toContain(expected);
    }
  });

  it("handles absent optional values and normalized substring matching", () => {
    const session = { id: "Mixed-Case-ID", status: "queued" };

    expect(sessionSearchableText(session)).toBe("mixed-case-id\nqueued");
    expect(sessionMatchesSearch(session, "  CASE-id  ")).toBe(true);
    expect(sessionMatchesSearch(session, "   ")).toBe(true);
    expect(sessionMatchesSearch(session, "missing")).toBe(false);
  });
});
