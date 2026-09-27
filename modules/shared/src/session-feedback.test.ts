import { describe, expect, it } from "vitest";
import {
  isSessionFeedback,
  mergeSessionFeedback,
  type SessionFeedback,
} from "./session-feedback.ts";
import { normalizeSessionResult, isSessionResult } from "./session-result.ts";

import { validFeedback } from "../test-helpers/session-feedback.ts";

describe("bounded session feedback", () => {
  it("preserves assessed coverage through result normalization", () => {
    const result = normalizeSessionResult({
      summary: "Done",
      summarySource: "harness",
      feedback: validFeedback(),
    });
    expect(result?.feedback).toEqual(validFeedback());
    expect(isSessionResult(result)).toBe(true);
  });
  it.each([
    { rawLogs: "opaque" },
    { assessments: undefined },
    { droppedCount: 1 },
    {
      assessments: {
        architecture: "not-assessed",
        sandbox: "none-observed",
        tools: "none-observed",
      },
    },
    { completionKind: "shepherd-terminal" },
    { shepherdAction: "waiting" },
    { findings: [{ category: "tool", recurrence: "one-off", summary: "Bearer abcdefghijklmnop" }] },
    { findings: [{ category: "tool", recurrence: "one-off", summary: "secret=abcdefghijk" }] },
    {
      findings: [
        { category: "tool", recurrence: "one-off", summary: "observed", source: "/tmp/log" },
      ],
    },
    { findings: [{ category: "tool", recurrence: "one-off", summary: "x".repeat(257) }] },
  ])("rejects invalid, incomplete or sensitive full-coverage claims %#", (override) => {
    expect(isSessionFeedback({ ...validFeedback(), ...override })).toBe(false);
  });
  it("retains primary findings when a hook replaces the artifact and marks bounded loss partial", () => {
    const primary: SessionFeedback = {
      ...validFeedback(),
      assessments: { ...validFeedback().assessments, architecture: "finding" },
      findings: Array.from({ length: 20 }, (_, index) => ({
        category: "architecture",
        recurrence: "recurring",
        summary: `finding ${index}`,
      })),
    };
    const terminal: SessionFeedback = {
      ...validFeedback(),
      assessments: { ...validFeedback().assessments, tools: "finding" },
      findings: [{ category: "tool", recurrence: "one-off", summary: "later observation" }],
    };
    const result = mergeSessionFeedback(primary, terminal)!;
    expect(result.assessments.architecture).toBe("finding");
    expect(result.findings).toHaveLength(20);
    expect(result.droppedCount).toBe(1);
    expect(result.feedbackCoverage).toBe("partial");
    expect(mergeSessionFeedback(primary, undefined)).toBe(primary);
    expect(mergeSessionFeedback(undefined, terminal)).toBe(terminal);
    expect(isSessionFeedback(result)).toBe(true);
  });
});

it("rejects invented assessments and preserves unchanged snapshot loss counts", () => {
  const base: SessionFeedback = {
    schemaVersion: 1,
    completionKind: "no-change",
    feedbackCoverage: "complete",
    assessments: {
      architecture: "none-observed",
      sandbox: "none-observed",
      tools: "none-observed",
    },
    assessmentEvidence: {
      architecture: "Inspected the changed module boundary; no issue observed.",
      sandbox: "Inspected this attempt authorization and execution boundary; no issue observed.",
      tools: "No additional workflow tool was applicable to this scoped command.",
    },
    toolAssessments: [],
    findings: [],
    droppedCount: 0,
  };
  expect(
    isSessionFeedback({ ...base, assessments: { ...base.assessments, architecture: "finding" } }),
  ).toBe(false);
  expect(
    isSessionFeedback({
      ...base,
      findings: [{ category: "architecture", recurrence: "one-off", summary: "Observed coupling" }],
    }),
  ).toBe(false);
  const unavailable: SessionFeedback = {
    ...base,
    feedbackCoverage: "unavailable",
    assessments: { architecture: "unavailable", sandbox: "unavailable", tools: "unavailable" },
    droppedCount: 1,
  };
  expect(mergeSessionFeedback(unavailable, structuredClone(unavailable))).toEqual(unavailable);
});

it("keeps merged tool truncation partial, canonical duplicate observations idempotent, and sources relative", () => {
  const primary = {
    ...validFeedback(),
    toolAssessments: Array.from({ length: 10 }, (_, i) => ({
      name: `primary-${i}`,
      status: "used" as const,
      reason: "Validated the scoped change.",
    })),
  };
  const terminal = {
    ...validFeedback(),
    toolAssessments: Array.from({ length: 10 }, (_, i) => ({
      name: `terminal-${i}`,
      status: "skipped" as const,
      reason: "Not applicable to the scoped change.",
    })),
  };
  const merged = mergeSessionFeedback(primary, terminal)!;
  expect(merged.feedbackCoverage).toBe("partial");
  expect(merged.droppedCount).toBe(10);
  expect(isSessionFeedback(merged)).toBe(true);
  const reordered = Object.fromEntries(
    Object.entries(primary).toReversed(),
  ) as unknown as SessionFeedback;
  expect(mergeSessionFeedback(primary, reordered)).toBe(primary);
  for (const source of [
    "C:\\Users\\person\\private.ts",
    "\\\\server\\share\\private.ts",
    "/private/file.ts",
    "../private.ts",
  ]) {
    expect(
      isSessionFeedback({
        ...validFeedback(),
        assessments: { ...validFeedback().assessments, architecture: "finding" },
        findings: [
          {
            category: "architecture",
            recurrence: "one-off",
            summary: "Observed module coupling.",
            source,
          },
        ],
      }),
    ).toBe(false);
  }
});
