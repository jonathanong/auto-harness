import { expect, it } from "vitest";
import { isSessionFeedback } from "./session-feedback.ts";
import { validFeedback } from "../test-helpers/session-feedback.ts";

it.each([
  null,
  [],
  4,
  {},
  { ...validFeedback(), schemaVersion: 2 },
  { ...validFeedback(), completionKind: "invented" },
  { ...validFeedback(), feedbackCoverage: "invented" },
  ...[-1, 0.5, NaN, Infinity, 1_000_001].map((droppedCount) => ({
    ...validFeedback(),
    droppedCount,
  })),
  { ...validFeedback(), assessments: [] },
  { ...validFeedback(), assessments: { ...validFeedback().assessments, extra: "none-observed" } },
  { ...validFeedback(), assessments: { ...validFeedback().assessments, tools: "unknown" } },
  { ...validFeedback(), assessmentEvidence: [] },
  {
    ...validFeedback(),
    assessmentEvidence: { ...validFeedback().assessmentEvidence, extra: "text" },
  },
  ...["", "x".repeat(257), "unsafe\u0000text", "Bearer private-credential"].map((architecture) => ({
    ...validFeedback(),
    assessmentEvidence: { ...validFeedback().assessmentEvidence, architecture },
  })),
  { ...validFeedback(), toolAssessments: {} },
  {
    ...validFeedback(),
    toolAssessments: Array.from({ length: 11 }, (_, i) => ({
      name: `tool-${i}`,
      status: "used",
      reason: "Scoped check.",
    })),
  },
  ...[
    null,
    { name: "tool", status: "used", reason: "scope", raw: "opaque" },
    { name: "", status: "used", reason: "scope" },
    { name: "x".repeat(65), status: "used", reason: "scope" },
    { name: "tool", status: "unknown", reason: "scope" },
    { name: "tool", status: "used", reason: "" },
  ].map((tool) => ({ ...validFeedback(), toolAssessments: [tool] })),
  {
    ...validFeedback(),
    toolAssessments: [
      { name: "tool", status: "used", reason: "scope" },
      { name: "tool", status: "skipped", reason: "scope" },
    ],
  },
  { ...validFeedback(), findings: {} },
  {
    ...validFeedback(),
    findings: Array.from({ length: 21 }, () => ({
      category: "tool",
      recurrence: "one-off",
      summary: "Observed issue.",
    })),
  },
  ...[
    null,
    { category: "tool", recurrence: "one-off", summary: "scope", raw: "opaque" },
    { category: "unknown", recurrence: "one-off", summary: "scope" },
    { category: "tool", recurrence: "unknown", summary: "scope" },
    { category: "tool", recurrence: "one-off", summary: "" },
  ].map((finding) => ({ ...validFeedback(), findings: [finding] })),
])("rejects unbounded or untrusted report shape %# before result persistence", (input) => {
  expect(isSessionFeedback(input)).toBe(false);
});

it("accepts an observed shepherd terminal action and rejects oversized multibyte evidence", () => {
  expect(
    isSessionFeedback({
      ...validFeedback(),
      completionKind: "shepherd-terminal",
      shepherdAction: "ready",
    }),
  ).toBe(true);
  const large = {
    ...validFeedback(),
    assessments: { architecture: "finding", sandbox: "none-observed", tools: "none-observed" },
    findings: Array.from({ length: 20 }, () => ({
      category: "architecture",
      recurrence: "one-off",
      summary: "x".repeat(256),
      source: "s".repeat(256),
    })),
  };
  expect(isSessionFeedback(large)).toBe(false);
  expect(
    isSessionFeedback({
      ...validFeedback(),
      assessmentEvidence: { ...validFeedback().assessmentEvidence, architecture: "é".repeat(129) },
    }),
  ).toBe(false);
});

it.each([
  "Observed /Users/person/private/file.ts.",
  "Observed C:\\Users\\person\\private.ts.",
  "Observed \\\\server\\private.",
  "artifact=/private/tmp/private.json",
  "Evidence file:///private/tmp/private.json",
  "Evidence file://localhost/private/tmp/private.json",
  "Evidence FILE:/private/tmp/private.json",
])("rejects absolute paths in every agent-authored evidence field: %s", (text) => {
  const base = validFeedback();
  expect(
    isSessionFeedback({
      ...base,
      assessmentEvidence: { ...base.assessmentEvidence, architecture: text },
    }),
  ).toBe(false);
  expect(
    isSessionFeedback({
      ...base,
      toolAssessments: [{ name: "tool", status: "used", reason: text }],
    }),
  ).toBe(false);
  expect(
    isSessionFeedback({
      ...base,
      assessments: { ...base.assessments, architecture: "finding" },
      findings: [{ category: "architecture", recurrence: "one-off", summary: text }],
    }),
  ).toBe(false);
});

it("preserves repository-relative evidence and actionable HTTPS issue/PR links", () => {
  const reference =
    "Inspected modules/shared/src/session.ts; see https://github.com/owner/repo/pull/1 (https://github.com/owner/repo/issues/2).";
  const base = validFeedback();
  expect(
    isSessionFeedback({
      ...base,
      assessments: { ...base.assessments, architecture: "finding" },
      assessmentEvidence: { ...base.assessmentEvidence, architecture: reference },
      toolAssessments: [
        {
          name: "pr-shepherd",
          status: "used",
          reason: "Reviewed https://github.com/owner/repo/pull/1.",
        },
      ],
      findings: [
        {
          category: "architecture",
          recurrence: "one-off",
          summary: reference,
          source: "modules/shared/src/session.ts",
        },
      ],
    }),
  ).toBe(true);
});
