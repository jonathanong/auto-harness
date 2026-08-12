import { describe, expect, it } from "vitest";

import { cloneSourceId, includeDraftTargets, sessionCloneDraft } from "./session-clone-draft.ts";

describe("session clone edit draft", () => {
  it("copies only replayable create fields and supplies legacy defaults", () => {
    expect(
      sessionCloneDraft({
        repositoryId: "repository",
        prompt: "fix it",
        target: { providerId: "provider" },
        fallbacks: [{ commandId: "command" }, { providerId: "bad", commandId: "bad" }],
        requiredLabels: ["gpu"],
        ref: "feature/ref",
        concurrencyId: "must-not-copy",
        metadata: { secret: "must-not-copy" },
        cliResumeRef: "must-not-copy",
        resolvedArgv: ["must-not-copy"],
      } as never),
    ).toEqual({
      repositoryId: "repository",
      prompt: "fix it",
      target: { providerId: "provider" },
      fallbacks: [{ commandId: "command" }],
      queueTtlSeconds: 691_200,
      timeout: 600,
      priority: 0,
      requiredLabels: ["gpu"],
      ref: "feature/ref",
    });
  });

  it("preserves numeric inputs, omits an empty ref, and rejects incomplete sources", () => {
    expect(
      sessionCloneDraft({
        repositoryId: "repository",
        prompt: "again",
        target: { commandId: "command" },
        fallbacks: null,
        queueTtlSeconds: 60,
        timeout: 30,
        priority: 75,
        requiredLabels: null,
        ref: "",
      }),
    ).toEqual({
      repositoryId: "repository",
      prompt: "again",
      target: { commandId: "command" },
      fallbacks: [],
      queueTtlSeconds: 60,
      timeout: 30,
      priority: 75,
      requiredLabels: [],
    });
    expect(
      sessionCloneDraft({ prompt: "missing repository", target: { commandId: "c" } }),
    ).toBeNull();
    expect(
      sessionCloneDraft({ repositoryId: "r", prompt: null, target: { commandId: "c" } }),
    ).toBeNull();
    expect(sessionCloneDraft({ repositoryId: "r", prompt: "p", target: null })).toBeNull();
  });

  it("keeps current targets and adds missing draft routes once as unavailable", () => {
    const targets = [{ kind: "provider" as const, id: "provider", label: "Provider" }];
    expect(includeDraftTargets(targets, null)).toBe(targets);
    expect(
      includeDraftTargets(targets, {
        repositoryId: "repository",
        prompt: "prompt",
        target: { providerId: "provider" },
        fallbacks: [{ commandId: "missing" }, { commandId: "missing" }],
        queueTtlSeconds: 1,
        timeout: 1,
        priority: 0,
        requiredLabels: [],
      }),
    ).toEqual([
      { kind: "provider", id: "provider", label: "Provider" },
      {
        kind: "command",
        id: "missing",
        label: "Unavailable command missing",
        available: false,
      },
    ]);
  });

  it("accepts only one bounded clone source id", () => {
    expect(cloneSourceId("session/one")).toBe("session/one");
    expect(cloneSourceId(undefined)).toBeNull();
    expect(cloneSourceId("")).toBeNull();
    expect(cloneSourceId(["one", "two"])).toBeNull();
    expect(cloneSourceId("x".repeat(513))).toBeNull();
  });
});
