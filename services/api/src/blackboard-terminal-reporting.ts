import type { FeedbackEnvelope } from "vouchington-tooling/agent-blackboard";
import {
  isTerminalSessionStatus,
  type SessionReporting,
  type SessionFeedback,
} from "@auto-harness/shared";
import type { SessionRecord } from "./db/types.ts";
import { createWebhookDelivery, type DurableWebhookDelivery } from "./webhook-outbox.ts";

export type BlackboardTerminalSnapshot = Pick<
  SessionRecord,
  | "id"
  | "repositoryId"
  | "workspacePoolId"
  | "principalId"
  | "parentSessionId"
  | "attemptId"
  | "status"
  | "completedAt"
  | "reportingMode"
  | "reportingRepository"
  | "reportingPolicyVersion"
  | "reportingAgentVersion"
  | "activeHostId"
  | "assignmentConnectionId"
  | "terminalHookHandoff"
> & { result?: { feedback?: SessionFeedback } };

export const BLACKBOARD_DESTINATION = "agent-blackboard";
export function blackboardIdentity(session: BlackboardTerminalSnapshot) {
  return {
    sessionId: session.id,
    parentSessionId: session.parentSessionId ?? null,
    agent: "auto-harness" as const,
    version: session.reportingAgentVersion ?? "unknown",
  };
}

function workOutcome(session: BlackboardTerminalSnapshot): FeedbackEnvelope["workOutcome"] {
  if (session.status === "cancelled") return "cancelled";
  if (session.status === "timed_out") return "timed-out";
  if (session.status === "failed") return "failure";
  if (
    session.status === "completed" &&
    session.result?.feedback?.completionKind === "policy-refusal"
  )
    return "policy-refusal";
  if (session.status === "completed")
    return session.result?.feedback?.completionKind === "no-change" ? "no-change" : "success";
  return "in-progress";
}

/** Only the fixed feedback schema is rendered; prompts, logs, result summary, and freeform errors are excluded. */
export function terminalFeedbackEnvelope(
  session: BlackboardTerminalSnapshot,
  sourceEventId: string,
): FeedbackEnvelope {
  const feedback = session.result?.feedback;
  const coverage =
    feedback?.feedbackCoverage ?? (session.attemptId ? "unavailable" : "not-started");
  const markdown = [
    `Harness session ${session.id}: ${session.status}.`,
    `Evidence coverage: ${coverage}.`,
    feedback
      ? `Architecture: ${feedback.assessments.architecture}; sandbox: ${feedback.assessments.sandbox}; tools: ${feedback.assessments.tools}.`
      : "Architecture, sandbox, and tools: unavailable; no valid feedback artifact was received.",
    ...(feedback
      ? [
          `Architecture scope/reason: ${feedback.assessmentEvidence.architecture}`,
          `Sandbox scope/reason: ${feedback.assessmentEvidence.sandbox}`,
          `Tools scope/reason: ${feedback.assessmentEvidence.tools}`,
          ...feedback.toolAssessments.map(
            (tool) => `Tool ${tool.name}: ${tool.status}; ${tool.reason}`,
          ),
        ]
      : []),
    ...(feedback?.findings.map(
      (finding) =>
        `- ${finding.recurrence} / ${finding.category}: ${finding.summary}${finding.source ? ` (${finding.source})` : ""}`,
    ) ?? []),
    ...(feedback?.shepherdAction ? [`Shepherd terminal action: ${feedback.shepherdAction}.`] : []),
  ].join("\n");
  return {
    schemaVersion: 1,
    type: "retrospective",
    sourceEventId,
    timestamp: session.completedAt!,
    repositories: [session.reportingRepository!],
    markdown,
    workOutcome: workOutcome(session),
    date: session.completedAt!.slice(0, 10),
    issues: [],
    prs: [],
    feedbackCoverage: {
      status: coverage,
      sources: feedback ? ["harness-feedback-artifact"] : [],
      droppedCount: feedback?.droppedCount ?? 0,
    },
  };
}

export function reportingDelivery(
  session: BlackboardTerminalSnapshot,
): DurableWebhookDelivery | undefined {
  if (
    !isTerminalSessionStatus(session.status) ||
    !session.completedAt ||
    session.activeHostId ||
    session.assignmentConnectionId ||
    session.terminalHookHandoff ||
    !session.reportingRepository ||
    !session.reportingPolicyVersion
  )
    return undefined;
  return createWebhookDelivery({
    sessionId: session.id,
    repositoryId: session.repositoryId || null,
    workspacePoolId: session.workspacePoolId ?? null,
    attemptId: session.attemptId ?? null,
    status: session.status,
    occurredAt: session.completedAt,
    destination: {
      configurationId: BLACKBOARD_DESTINATION,
      configurationVersion: session.reportingPolicyVersion,
    },
    maxAttempts: 10,
  });
}

export function sessionReporting(
  session: SessionRecord,
  delivery?: DurableWebhookDelivery | null,
): SessionReporting {
  const terminal = isTerminalSessionStatus(session.status) && Boolean(session.completedAt);
  const coverage =
    session.result?.feedback?.feedbackCoverage ??
    (terminal ? (session.attemptId ? "unavailable" : "not-started") : "not-started");
  const delivered = delivery?.state === "delivered";
  return {
    protocolVersion: 1,
    mode: "autonomous",
    deliveryStatus: delivered
      ? "delivered"
      : delivery?.state === "dead" ||
          delivery?.lastFailureCode === "configuration-unavailable" ||
          session.reportingAdmissionBlocked ||
          !session.reportingRepository
        ? "blocked"
        : terminal
          ? "pending"
          : "not-started",
    feedbackCoverage: coverage,
    completionStatus: !terminal
      ? "in-progress"
      : delivered && (session.status !== "completed" || coverage === "complete")
        ? "complete"
        : "incomplete",
    ...(delivery ? { sourceEventId: delivery.event.id } : {}),
    ...(delivery?.deliveredAt ? { deliveredAt: delivery.deliveredAt } : {}),
  };
}
