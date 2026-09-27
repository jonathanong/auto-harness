import type { SessionFeedback } from "../src/session-feedback.ts";

export function validFeedback(): SessionFeedback {
  return {
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
}
