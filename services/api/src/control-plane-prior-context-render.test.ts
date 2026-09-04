import { MAX_PRIOR_CONTEXT_BYTES } from "@auto-harness/shared";
import { describe, expect, it } from "vitest";

import type { LogRecord } from "./control-plane-types.ts";
import { renderPriorSessionContext } from "./control-plane-prior-context.ts";

function logRecord(overrides: Partial<LogRecord>): LogRecord {
  return {
    sessionId: "src",
    timestampSeq: "2026-01-01T00:00:00.000Z#0000000001",
    stream: "stdout",
    content: "hello",
    timestamp: "2026-01-01T00:00:00.000Z",
    seq: 1,
    ...overrides,
  };
}

describe("renderPriorSessionContext", () => {
  const source = {
    id: "src",
    status: "completed" as const,
    completedAt: "2026-01-01T00:00:01.000Z",
    prompt: "do the thing",
  };

  it("returns null when there are no logs", () => {
    expect(renderPriorSessionContext(source, [])).toBeNull();
  });

  it("renders a markdown transcript with stream prefixes and header fields", () => {
    const rendered = renderPriorSessionContext(source, [
      logRecord({ content: "building", stream: "stdout" }),
      logRecord({ content: "warning: slow", stream: "stderr" }),
      logRecord({ content: "Process exited with code 0", stream: "system" }),
    ]);
    expect(rendered).not.toBeNull();
    expect(rendered!.truncated).toBe(false);
    expect(rendered!.content).toContain("# Prior session src");
    expect(rendered!.content).toContain("- Status: completed");
    expect(rendered!.content).toContain("do the thing");
    expect(rendered!.content).toContain("building");
    expect(rendered!.content).toContain("[stderr] warning: slow");
    expect(rendered!.content).toContain("[system] Process exited with code 0");
  });

  it("includes errorCode/errorMessage when present", () => {
    const rendered = renderPriorSessionContext(
      { ...source, status: "failed", errorCode: "usage_limit", errorMessage: "limited" },
      [logRecord({})],
    );
    expect(rendered!.content).toContain("- Error code: usage_limit");
    expect(rendered!.content).toContain("- Error: limited");
  });

  it("caps a pathologically large errorMessage instead of starving the transcript body", () => {
    const rendered = renderPriorSessionContext(
      { ...source, status: "failed", errorMessage: "z".repeat(5_000_000) },
      [logRecord({ content: "still here" })],
    );
    expect(rendered!.content).toContain("still here");
    expect(rendered!.content).toContain("- Error: ");
  });

  it("truncates a transcript exceeding the byte cap and says so", () => {
    const logs = Array.from({ length: 3000 }, (_, i) =>
      logRecord({
        content: "x".repeat(1000),
        seq: i,
        timestampSeq: `2026-01-01T00:00:00.000Z#${String(i).padStart(10, "0")}`,
      }),
    );
    const rendered = renderPriorSessionContext(source, logs);
    expect(rendered!.truncated).toBe(true);
    expect(rendered!.content).toContain("Truncated");
    // The truncation notice and the trailing newline this function always appends
    // must both be reserved out of the same budget, not appended on top of it, or
    // a truncated render could itself exceed the cap.
    expect(new TextEncoder().encode(rendered!.content).length).toBeLessThanOrEqual(
      MAX_PRIOR_CONTEXT_BYTES,
    );
  });

  it("keeps the newest content and drops the oldest when truncating, without joining every record first", () => {
    const logs = Array.from({ length: 3000 }, (_, i) =>
      logRecord({
        content: i === 0 ? "OLDEST-MARKER" : i === 2999 ? "NEWEST-MARKER" : "x".repeat(1000),
        seq: i,
        timestampSeq: `2026-01-01T00:00:00.000Z#${String(i).padStart(10, "0")}`,
      }),
    );
    const rendered = renderPriorSessionContext(source, logs);
    expect(rendered!.truncated).toBe(true);
    expect(rendered!.content).not.toContain("OLDEST-MARKER");
    expect(rendered!.content).toContain("NEWEST-MARKER");
  });

  it("truncates an oversized prompt excerpt", () => {
    const rendered = renderPriorSessionContext({ ...source, prompt: "y".repeat(5000) }, [
      logRecord({}),
    ]);
    expect(rendered!.content).toContain("…");
  });

  it("marks a transcript truncated once it hits the record cap, even under the byte cap", () => {
    const logs = Array.from({ length: 4_000 }, (_, i) =>
      logRecord({
        content: "short",
        seq: i,
        timestampSeq: `2026-01-01T00:00:00.000Z#${String(i).padStart(10, "0")}`,
      }),
    );
    const rendered = renderPriorSessionContext(source, logs);
    expect(rendered!.truncated).toBe(true);
    expect(rendered!.content).toContain("Truncated");
  });

  it("does not split a multi-byte codepoint at the prompt-excerpt boundary", () => {
    // Each "é" is 2 UTF-8 bytes; repeating past MAX_PROMPT_EXCERPT_BYTES (2 KiB)
    // forces the head-trim to land mid-character unless it backs up correctly.
    const rendered = renderPriorSessionContext({ ...source, prompt: "é".repeat(1200) }, [
      logRecord({}),
    ]);
    expect(rendered!.content).not.toContain("�");
  });

  it("backs up over a continuation byte that lands exactly on the head-excerpt cutoff", () => {
    // A one-byte ASCII prefix shifts every "é" pair onto an odd byte offset, so the
    // fixed 2048-byte cutoff (even) lands on a continuation byte and forces a backup —
    // unlike the aligned case above, where the cutoff always lands on a lead byte.
    const rendered = renderPriorSessionContext({ ...source, prompt: "x" + "é".repeat(1200) }, [
      logRecord({}),
    ]);
    expect(rendered!.content).not.toContain("�");
  });

  it("does not split a multi-byte codepoint at the transcript tail boundary", () => {
    const logs = [
      logRecord({ content: "x".repeat(3_000_000) }),
      logRecord({
        content: "é".repeat(500),
        seq: 2,
        timestampSeq: "2026-01-01T00:00:00.000Z#0000000002",
      }),
    ];
    const rendered = renderPriorSessionContext(source, logs);
    expect(rendered!.truncated).toBe(true);
    expect(rendered!.content).not.toContain("�");
  });

  it("backs up over a continuation byte that lands exactly on the tail-trim cutoff", () => {
    // An all-"é" body guarantees the byte cutoff falls inside the multi-byte run
    // (unlike the mixed ASCII+é case above, where it never reaches the é region). A
    // one-byte trailing pad shifts the cutoff's parity relative to the "é" run's own
    // alignment without changing where the run itself starts; across the padded and
    // unpadded variants, one of the two always lands exactly on a continuation byte,
    // regardless of the exact header/notice byte count.
    for (const content of ["é".repeat(1_200_000), `${"é".repeat(1_200_000)}z`]) {
      const rendered = renderPriorSessionContext(source, [logRecord({ content })]);
      expect(rendered!.truncated).toBe(true);
      expect(rendered!.content).not.toContain("�");
    }
  });

  it("omits the completed-at line when the source has not recorded one", () => {
    const rendered = renderPriorSessionContext({ ...source, completedAt: undefined }, [
      logRecord({}),
    ]);
    expect(rendered!.content).not.toContain("Completed at:");
  });
});
