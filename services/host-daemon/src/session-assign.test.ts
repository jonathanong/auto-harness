import { describe, expect, it } from "vitest";

import { sessionAssignFromWire } from "./session-assign.ts";

describe("sessionAssignFromWire", () => {
  it("preserves every optional assignment field when supplied", () => {
    expect(
      sessionAssignFromWire({
        type: "session:assign",
        sessionId: "s",
        sessionType: "scheduled",
        attemptId: "attempt-1",
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
        targetIndex: 1,
        commandId: "cmd-1",
        providerAccountId: "acct-1",
        assignedAt: "now",
      }),
    ).toMatchObject({
      sessionType: "scheduled",
      attemptId: "attempt-1",
      ref: "main",
      setupScript: "true",
      resume: true,
      cliResumeRef: "ref",
      targetIndex: 1,
      commandId: "cmd-1",
      providerAccountId: "acct-1",
    });
  });

  it("does not manufacture absent optional fields", () => {
    expect(
      sessionAssignFromWire({
        type: "session:assign",
        sessionId: "s",
        attemptId: "attempt-1",
        repositoryId: "r",
        prompt: "p",
        resolvedArgv: [],
        timeout: 10,
        worktreeId: null,
        assignedAt: "now",
      }),
    ).toEqual({
      sessionId: "s",
      attemptId: "attempt-1",
      repositoryId: "r",
      prompt: "p",
      resolvedArgv: [],
      timeout: 10,
      worktreeId: null,
    });
  });
});
