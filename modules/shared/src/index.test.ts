import { describe, expect, it } from "vitest";

import * as shared from "./index.ts";
import type { SessionAssign } from "./session.ts";

describe("package exports", () => {
  it("re-exports validation helpers and constants", () => {
    expect(typeof shared.validateCreateSessionInput).toBe("function");
    expect(typeof shared.formatLogSortKey).toBe("function");
    expect(typeof shared.isUserRole).toBe("function");
    expect(typeof shared.roleHas).toBe("function");
    expect(typeof shared.principalHas).toBe("function");
    expect(typeof shared.isWorktreeStatus).toBe("function");
    expect(shared.SESSION_STATUSES.length).toBeGreaterThan(0);
    expect(shared.USER_ROLES).toContain("admin");
    expect(shared.WORKTREE_STATUSES).toContain("idle");
    expect(shared.PACKAGE_SCOPE).toBe("@auto-harness");
  });

  it("exposes session assign typing at runtime via usage", () => {
    const assign: SessionAssign = {
      sessionId: "s1",
      repositoryId: "r1",
      prompt: "p",
      resolvedArgv: ["codex", "fix"],
      timeout: 60,
      worktreeId: "wt-1",
    };
    expect(assign.resolvedArgv).toEqual(["codex", "fix"]);
  });
});
