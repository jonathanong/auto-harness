import { describe, expect, it } from "vitest";

import { resolveTerminalHookCompletionResult } from "./terminal-hook-handoff.ts";

describe("terminal hook completion result", () => {
  it("keeps a collected result and fills a v6 fail-closed fallback", () => {
    const collected = { summary: "post-hook", summarySource: "harness" as const };
    expect(resolveTerminalHookCompletionResult(6, "failed", collected)).toEqual(collected);
    expect(resolveTerminalHookCompletionResult(6, "failed")).toEqual({
      summary: "Session failed",
      summarySource: "harness",
    });
    expect(resolveTerminalHookCompletionResult(7, "timed_out")).toEqual({
      summary: "Session timed_out",
      summarySource: "harness",
    });
  });

  it("preserves protocol-v5 host-loss completions without a result", () => {
    expect(resolveTerminalHookCompletionResult(5, "failed")).toBeUndefined();
    expect(
      resolveTerminalHookCompletionResult(5, "failed", {
        summary: "optional",
        summarySource: "harness",
      }),
    ).toEqual({ summary: "optional", summarySource: "harness" });
  });
});
