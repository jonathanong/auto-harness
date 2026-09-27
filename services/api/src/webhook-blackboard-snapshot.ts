import { validateFeedbackEnvelope } from "vouchington-tooling/agent-blackboard";
import type { BlackboardDeliveryPayload } from "./webhook-outbox.ts";

export function assertBlackboardDeliverySnapshot(
  feedback: BlackboardDeliveryPayload,
  sessionId: string,
  eventId: string,
  repositoryId: string | null,
  workspacePoolId: string | null,
  configurationId: string,
  configurationVersion: number,
): void {
  if (configurationId !== "agent-blackboard")
    throw new TypeError("invalid Blackboard delivery destination");
  const { identity, authorization } = feedback;
  if (
    Object.keys(feedback).some((key) => !["identity", "envelope", "authorization"].includes(key)) ||
    Object.keys(identity).some(
      (key) => !["sessionId", "parentSessionId", "agent", "version"].includes(key),
    ) ||
    Object.keys(authorization).some(
      (key) => !["repositoryId", "workspacePoolId", "principalId", "policyVersion"].includes(key),
    ) ||
    identity.agent !== "auto-harness" ||
    typeof identity.version !== "string" ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(identity.version) ||
    !(
      identity.parentSessionId === null ||
      (typeof identity.parentSessionId === "string" &&
        /^[A-Za-z0-9_-]{1,512}$/.test(identity.parentSessionId))
    ) ||
    !/^[A-Za-z0-9_:.-]{1,512}$/.test(authorization.principalId) ||
    authorization.workspacePoolId !== (workspacePoolId ?? undefined)
  )
    throw new TypeError("invalid Blackboard delivery snapshot");
  validateFeedbackEnvelope(feedback.envelope);
  if (
    feedback.identity.sessionId !== sessionId ||
    feedback.envelope.sourceEventId !== eventId ||
    feedback.authorization.repositoryId !== repositoryId ||
    feedback.authorization.policyVersion !== configurationVersion
  )
    throw new TypeError("invalid Blackboard delivery snapshot");
}
