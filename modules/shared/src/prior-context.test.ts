import { describe, expect, it } from "vitest";

import {
  MAX_PRIOR_CONTEXT_BYTES,
  PRIOR_CONTEXT_DIR,
  PRIOR_CONTEXT_FILENAME,
  PRIOR_CONTEXT_RELATIVE_PATH,
  appendPriorContextPointer,
  hasPriorContextPointer,
} from "./prior-context.ts";
import { MAX_PROMPT_BYTES } from "./validation.ts";

describe("prior-context", () => {
  it("exposes the reserved worktree path as one shared constant", () => {
    expect(PRIOR_CONTEXT_RELATIVE_PATH).toBe(`${PRIOR_CONTEXT_DIR}/${PRIOR_CONTEXT_FILENAME}`);
    expect(MAX_PRIOR_CONTEXT_BYTES).toBeGreaterThan(0);
  });

  it("appends the pointer once and reports its presence", () => {
    const withPointer = appendPriorContextPointer("Continue the work.");
    expect(withPointer).toContain(PRIOR_CONTEXT_RELATIVE_PATH);
    expect(withPointer.startsWith("Continue the work.")).toBe(true);
    expect(hasPriorContextPointer("Continue the work.")).toBe(false);
    expect(hasPriorContextPointer(withPointer)).toBe(true);
  });

  it("is idempotent — a second append is a no-op", () => {
    const once = appendPriorContextPointer("Continue.");
    const twice = appendPriorContextPointer(once);
    expect(twice).toBe(once);
  });

  it("leaves the prompt unchanged when appending would exceed MAX_PROMPT_BYTES", () => {
    const huge = "x".repeat(MAX_PROMPT_BYTES - 10);
    expect(appendPriorContextPointer(huge)).toBe(huge);
  });
});
