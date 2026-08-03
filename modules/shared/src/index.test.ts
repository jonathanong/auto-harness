import { describe, expect, it } from "vitest";

import * as shared from "./index.ts";
import type { SessionAssign } from "./session.ts";

describe("package exports", () => {
  it("re-exports validation helpers and constants", () => {
    expect(typeof shared.validateCreateSessionInput).toBe("function");
    expect(typeof shared.formatLogSortKey).toBe("function");
    expect(shared.SESSION_STATUSES.length).toBeGreaterThan(0);
    expect(shared.PACKAGE_SCOPE).toBe("@auto-harness");
  });

  it("exposes session assign typing at runtime via usage", () => {
    const assign: SessionAssign = {
      sessionId: "s1",
      repositoryId: "r1",
      prompt: "p",
      commandProfile: "codex-fix",
      timeout: 60,
      worktreeId: "wt-1",
    };
    expect(assign.commandProfile).toBe("codex-fix");
  });
});
