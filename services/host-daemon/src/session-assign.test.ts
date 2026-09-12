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
        infrastructureRetryCount: 1,
        ref: "main",
        setupScript: "true",
        resume: true,
        resumedFromSessionId: "old",
        cliResumeRef: "ref",
        metadata: { pr: 1 },
        targetIndex: 1,
        commandId: "cmd-1",
        providerAccountId: "acct-1",
        priorContext: { sourceSessionId: "old" },
        assignedAt: "now",
      }),
    ).toMatchObject({
      sessionType: "scheduled",
      attemptId: "attempt-1",
      infrastructureRetryCount: 1,
      ref: "main",
      setupScript: "true",
      resume: true,
      cliResumeRef: "ref",
      targetIndex: 1,
      commandId: "cmd-1",
      providerAccountId: "acct-1",
      priorContext: { sourceSessionId: "old" },
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

  it("preserves workspace-only assignment fields without accepting a script payload", () => {
    const assign = sessionAssignFromWire({
      type: "session:assign",
      sessionId: "workspace",
      sessionType: "workspace",
      attemptId: "attempt-1",
      repositoryId: null,
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      setupProfileId: "setup",
      destroyWorkspaceAfter: true,
      prompt: "run",
      resolvedArgv: ["echo", "workspace"],
      timeout: 10,
      worktreeId: null,
      assignedAt: "now",
    });

    expect(assign).toMatchObject({
      workspacePoolId: "pool",
      workspaceSlotId: "slot",
      setupProfileId: "setup",
      destroyWorkspaceAfter: true,
    });
    expect(assign).not.toHaveProperty("setupScript");
  });
});
