import { describe, expect, it } from "vitest";

import { resolveTerminalHookCompletionResult } from "./terminal-hook-handoff.ts";

describe("terminal hook completion result", () => {
  it("keeps a collected result and fills a fail-closed fallback", () => {
    const collected = { summary: "post-hook", summarySource: "harness" as const };
    expect(resolveTerminalHookCompletionResult("failed", collected)).toEqual(collected);
    expect(resolveTerminalHookCompletionResult("failed")).toEqual({
      summary: "Session failed",
      summarySource: "harness",
    });
    expect(resolveTerminalHookCompletionResult("timed_out")).toEqual({
      summary: "Session timed_out",
      summarySource: "harness",
    });
  });
});
