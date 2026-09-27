import { expect, it } from "vitest";
import {
  isSessionFeedback,
  mergeSessionFeedback,
  type SessionFeedback,
} from "./session-feedback.ts";
import { validFeedback } from "../test-helpers/session-feedback.ts";

function report(prefix: string): SessionFeedback {
  return {
    ...validFeedback(),
    assessments: { architecture: "finding", sandbox: "none-observed", tools: "none-observed" },
    findings: Array.from({ length: 10 }, (_, index) => ({
      category: "architecture",
      recurrence: "one-off",
      summary: `${prefix}${index}${"x".repeat(240)}`,
      source: `${prefix}${index}${"y".repeat(200)}`,
    })),
  };
}

it("retains bounded valid evidence when two valid reports exceed the combined byte budget", () => {
  const primary = report("primary");
  const terminal = report("terminal");
  expect(isSessionFeedback(primary)).toBe(true);
  expect(isSessionFeedback(terminal)).toBe(true);
  const merged = mergeSessionFeedback(primary, terminal)!;
  expect(isSessionFeedback(merged)).toBe(true);
  expect(merged.findings.length).toBeLessThan(20);
  expect(merged.droppedCount).toBe(20 - merged.findings.length);
  expect(merged.feedbackCoverage).toBe("partial");
});

it("is closed over bounded valid assessment, tool, finding, byte and loss combinations", () => {
  const samples: SessionFeedback[] = [
    validFeedback(),
    ...["partial", "unavailable"].map((coverage) => ({
      ...validFeedback(),
      feedbackCoverage: coverage as SessionFeedback["feedbackCoverage"],
      assessments: {
        architecture: "unavailable",
        sandbox: "not-assessed",
        tools: "unavailable",
      } as SessionFeedback["assessments"],
      droppedCount: coverage === "partial" ? 1_000_000 : 0,
    })),
  ];
  for (const length of [1, 10, 20])
    for (const width of [20, 200]) {
      samples.push({
        ...validFeedback(),
        feedbackCoverage: "partial",
        assessments: { architecture: "finding", sandbox: "none-observed", tools: "none-observed" },
        findings: Array.from({ length }, (_, index) => ({
          category: "architecture",
          recurrence: "one-off",
          summary: `${index}-${"x".repeat(width)}`,
        })),
        toolAssessments: Array.from({ length: 10 }, (_, index) => ({
          name: `tool-${width}-${index}`,
          status: "used",
          reason: "r".repeat(width),
        })),
        droppedCount: width === 200 ? 1_000_000 : 0,
      });
    }
  const valid = samples.filter(isSessionFeedback);
  expect(valid.length).toBeGreaterThan(4);
  for (const left of valid)
    for (const right of valid) {
      const merged = mergeSessionFeedback(left, right)!;
      expect(isSessionFeedback(merged)).toBe(true);
      expect(merged.droppedCount).toBeGreaterThanOrEqual(
        Math.max(left.droppedCount, right.droppedCount),
      );
      if (merged.droppedCount > 0) expect(merged.feedbackCoverage).not.toBe("complete");
      expect(
        mergeSessionFeedback(
          left,
          Object.fromEntries(Object.entries(left).toReversed()) as SessionFeedback,
        ),
      ).toEqual(left);
    }
});
