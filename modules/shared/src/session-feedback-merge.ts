import {
  MAX_SESSION_FEEDBACK_BYTES,
  type FeedbackAssessment,
  type SessionFeedback,
} from "./session-feedback.ts";

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).toSorted(([a], [b]) => a.localeCompare(b)))
      : child,
  );
}

/** A hook may replace its file, but cannot erase observations already captured from the command. */
export function mergeSessionFeedback(
  primary: SessionFeedback | undefined,
  terminal: SessionFeedback | undefined,
): SessionFeedback | undefined {
  if (!primary) return terminal;
  if (!terminal) return primary;
  if (canonical(primary) === canonical(terminal)) return primary;
  const all = [
    ...new Map(
      [...primary.findings, ...terminal.findings].map((finding) => [canonical(finding), finding]),
    ).values(),
  ];
  const droppedCount = Math.min(
    1_000_000,
    Math.max(primary.droppedCount, terminal.droppedCount) + Math.max(0, all.length - 20),
  );
  const rank: Record<FeedbackAssessment, number> = {
    unavailable: 0,
    "not-assessed": 1,
    "none-observed": 2,
    finding: 3,
  };
  const assessments = { ...terminal.assessments };
  const assessmentEvidence = { ...terminal.assessmentEvidence };
  for (const key of ["architecture", "sandbox", "tools"] as const) {
    if (rank[primary.assessments[key]] > rank[assessments[key]]) {
      assessments[key] = primary.assessments[key];
      assessmentEvidence[key] = primary.assessmentEvidence[key];
    }
  }
  const tools = [
    ...new Map(
      [...terminal.toolAssessments, ...primary.toolAssessments].map((tool) => [tool.name, tool]),
    ).values(),
  ];
  const totalDroppedCount = Math.min(1_000_000, droppedCount + Math.max(0, tools.length - 10));
  const merged: SessionFeedback = {
    ...terminal,
    assessments,
    assessmentEvidence,
    toolAssessments: tools.slice(0, 10),
    findings: all.slice(0, 20),
    droppedCount: totalDroppedCount,
    feedbackCoverage:
      totalDroppedCount === 0 &&
      primary.feedbackCoverage === "complete" &&
      terminal.feedbackCoverage === "complete"
        ? "complete"
        : "partial",
  };
  while (
    new TextEncoder().encode(JSON.stringify(merged)).byteLength > MAX_SESSION_FEEDBACK_BYTES &&
    merged.findings.length
  ) {
    merged.findings.pop();
    merged.droppedCount = Math.min(1_000_000, merged.droppedCount + 1);
    merged.feedbackCoverage = "partial";
  }
  return merged;
}
