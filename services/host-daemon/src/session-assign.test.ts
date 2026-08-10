import { describe, expect, it } from "vitest";

import { sessionAssignFromWire } from "./session-assign.ts";

describe("sessionAssignFromWire", () => {
  it("preserves every optional assignment field when supplied", () => {
    expect(
      sessionAssignFromWire({
        type: "session:assign",
        sessionId: "s",
        sessionType: "scheduled",
        repositoryId: "r",
        prompt: "p",
        resolvedArgv: ["echo", "p"],
        timeout: 10,
        worktreeId: "w",
        ref: "main",
        setupScript: "true",
        resume: true,
        resumedFromSessionId: "old",
        cliResumeRef: "ref",
        metadata: { pr: 1 },
        assignedAt: "now",
      }),
    ).toMatchObject({
      sessionType: "scheduled",
      ref: "main",
      setupScript: "true",
      resume: true,
      cliResumeRef: "ref",
    });
  });

  it("does not manufacture absent optional fields", () => {
    expect(
      sessionAssignFromWire({
        type: "session:assign",
        sessionId: "s",
        repositoryId: "r",
        prompt: "p",
        resolvedArgv: [],
        timeout: 10,
        worktreeId: null,
        assignedAt: "now",
      }),
    ).toEqual({
      sessionId: "s",
      repositoryId: "r",
      prompt: "p",
      resolvedArgv: [],
      timeout: 10,
      worktreeId: null,
    });
  });
});
