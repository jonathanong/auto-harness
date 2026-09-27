export type FeedbackAssessment = "finding" | "none-observed" | "not-assessed" | "unavailable";

/** Agent-authored evidence is optional and never controls identity, policy, or delivery. */
export type SessionFeedback = {
  schemaVersion: 1;
  completionKind: "changed" | "no-change" | "policy-refusal" | "shepherd-terminal" | "aborted";
  feedbackCoverage: "complete" | "partial" | "unavailable";
  assessments: {
    architecture: FeedbackAssessment;
    sandbox: FeedbackAssessment;
    tools: FeedbackAssessment;
  };
  assessmentEvidence: { architecture: string; sandbox: string; tools: string };
  toolAssessments: Array<{
    name: string;
    status: "used" | "skipped" | "unavailable";
    reason: string;
  }>;
  findings: Array<{
    category:
      | "architecture"
      | "sandbox"
      | "approval"
      | "guard"
      | "workflow"
      | "validation"
      | "tool";
    recurrence: "recurring" | "one-off";
    summary: string;
    source?: string;
  }>;
  droppedCount: number;
  shepherdAction?: "merged" | "closed" | "ready" | "blocked" | "cancelled";
};

export type SessionReporting = {
  protocolVersion: 1;
  mode: "autonomous";
  deliveryStatus: "not-started" | "pending" | "delivered" | "blocked";
  feedbackCoverage: "complete" | "partial" | "unavailable" | "not-started";
  completionStatus: "in-progress" | "complete" | "incomplete";
  sourceEventId?: string;
  deliveredAt?: string;
};

export const MAX_SESSION_FEEDBACK_BYTES = 8 * 1024;
const KINDS = new Set(["changed", "no-change", "policy-refusal", "shepherd-terminal", "aborted"]);
const COVERAGE = new Set(["complete", "partial", "unavailable"]);
const CATEGORIES = new Set([
  "architecture",
  "sandbox",
  "approval",
  "guard",
  "workflow",
  "validation",
  "tool",
]);
const ACTIONS = new Set(["merged", "closed", "ready", "blocked", "cancelled"]);
const SECRET =
  /(?:\bBearer\s+\S+|\b(?:Bearer|token|password|secret|api[_-]?key)\s*[:=]\s*\S+|\b(?:gh[pousr]_|sk-|hns_|AKIA)[A-Za-z0-9_-]{8,}|-----BEGIN [^-]*PRIVATE KEY)/i;

const ABSOLUTE_PATH = /(?:^|[\s"'`(=:])(?:\/(?!\/)[^\s/]|[A-Za-z]:[\\/]|\\\\)/;
const FILE_URL = /\bfile:(?:\/\/|\/)/i;

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function safeText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= maximum &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !SECRET.test(value) &&
    !ABSOLUTE_PATH.test(value) &&
    !FILE_URL.test(value)
  );
}

/** Reject extra fields instead of silently transporting logs or arbitrary metadata. */
export function isSessionFeedback(value: unknown): value is SessionFeedback {
  if (
    !object(value) ||
    !keys(value, [
      "schemaVersion",
      "completionKind",
      "feedbackCoverage",
      "assessments",
      "assessmentEvidence",
      "toolAssessments",
      "findings",
      "droppedCount",
      "shepherdAction",
    ])
  )
    return false;
  if (
    value.schemaVersion !== 1 ||
    !KINDS.has(value.completionKind as string) ||
    !COVERAGE.has(value.feedbackCoverage as string)
  )
    return false;
  if (
    !Number.isSafeInteger(value.droppedCount) ||
    (value.droppedCount as number) < 0 ||
    (value.droppedCount as number) > 1_000_000
  )
    return false;
  if (
    !object(value.assessments) ||
    !keys(value.assessments, ["architecture", "sandbox", "tools"]) ||
    !["architecture", "sandbox", "tools"].every((key) =>
      ["finding", "none-observed", "not-assessed", "unavailable"].includes(
        (value.assessments as Record<string, unknown>)[key] as string,
      ),
    )
  )
    return false;
  if (
    !object(value.assessmentEvidence) ||
    !keys(value.assessmentEvidence, ["architecture", "sandbox", "tools"]) ||
    !["architecture", "sandbox", "tools"].every((key) =>
      safeText((value.assessmentEvidence as Record<string, unknown>)[key], 256),
    )
  )
    return false;
  if (
    !Array.isArray(value.toolAssessments) ||
    value.toolAssessments.length > 10 ||
    !value.toolAssessments.every(
      (tool) =>
        object(tool) &&
        keys(tool, ["name", "status", "reason"]) &&
        safeText(tool.name, 64) &&
        ["used", "skipped", "unavailable"].includes(tool.status as string) &&
        safeText(tool.reason, 256),
    )
  )
    return false;
  if (
    new Set(value.toolAssessments.map((tool: Record<string, unknown>) => tool.name)).size !==
    value.toolAssessments.length
  )
    return false;
  if (
    value.feedbackCoverage === "complete" &&
    (value.droppedCount !== 0 ||
      Object.values(value.assessments).some(
        (assessment) => assessment !== "finding" && assessment !== "none-observed",
      ))
  )
    return false;
  if (!Array.isArray(value.findings) || value.findings.length > 20) return false;
  if (value.shepherdAction !== undefined && !ACTIONS.has(value.shepherdAction as string))
    return false;
  if (value.completionKind === "shepherd-terminal" && value.shepherdAction === undefined)
    return false;
  if (
    !value.findings.every(
      (finding) =>
        object(finding) &&
        keys(finding, ["category", "recurrence", "summary", "source"]) &&
        CATEGORIES.has(finding.category as string) &&
        (finding.recurrence === "recurring" || finding.recurrence === "one-off") &&
        safeText(finding.summary, 256) &&
        (finding.source === undefined ||
          (safeText(finding.source, 256) &&
            !finding.source.startsWith("/") &&
            !finding.source.includes("\\") &&
            !/^[A-Za-z]:/.test(finding.source) &&
            !finding.source.includes(".."))),
    )
  )
    return false;
  const groups = {
    architecture: ["architecture"],
    sandbox: ["sandbox", "approval", "guard"],
    tools: ["tool", "workflow", "validation"],
  };
  for (const [group, categories] of Object.entries(groups)) {
    const observed = value.findings.some((finding: Record<string, unknown>) =>
      categories.includes(finding.category as string),
    );
    const assessment = value.assessments[group];
    if (
      (assessment === "finding" &&
        !observed &&
        !(value.feedbackCoverage === "partial" && (value.droppedCount as number) > 0)) ||
      (observed && assessment !== "finding")
    )
      return false;
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_SESSION_FEEDBACK_BYTES;
}

export { mergeSessionFeedback } from "./session-feedback-merge.ts";
