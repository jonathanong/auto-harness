import { randomUUID } from "node:crypto";
import {
  verifyFreshFeedback,
  createFeedbackEnvelope,
  writeFeedback,
} from "vouchington-tooling/agent-blackboard";
import type { SessionRecord } from "./db/types.ts";
import { blackboardPolicy, type BlackboardConfig } from "./blackboard-config.ts";
import { type BlackboardDeliveryPayload } from "./webhook-outbox.ts";
import {
  BLACKBOARD_DESTINATION,
  blackboardIdentity,
  terminalFeedbackEnvelope,
  type BlackboardTerminalSnapshot,
} from "./blackboard-terminal-reporting.ts";
export {
  reportingDelivery,
  sessionReporting,
  type BlackboardTerminalSnapshot,
} from "./blackboard-terminal-reporting.ts";
import type { WebhookTransport, WebhookTransportRequest } from "./webhook-delivery-types.ts";

export type BlackboardReporting = {
  config: BlackboardConfig;
  requiresDurableStorage: boolean;
  authorizeAssignment(session: SessionRecord, attemptId: string): Promise<boolean>;
  authorize(session: SessionRecord, attemptId: string): Promise<boolean>;
  snapshot(session: BlackboardTerminalSnapshot, sourceEventId: string): BlackboardDeliveryPayload;
  deliver(request: WebhookTransportRequest): Promise<boolean>;
};

export function reportingPolicyFields(
  reporting: BlackboardReporting | undefined,
  repositoryId: string,
  principalId: string | undefined,
  workspacePoolId?: string,
): Pick<
  SessionRecord,
  "reportingMode" | "reportingPolicyVersion" | "reportingRepository" | "reportingAgentVersion"
> {
  const policy = blackboardPolicy(reporting?.config, repositoryId, principalId, workspacePoolId);
  return {
    reportingMode: "autonomous",
    reportingAgentVersion: process.env.HARNESS_BUILD_VERSION ?? "unknown",
    ...(policy && reporting
      ? { reportingPolicyVersion: reporting.config.version, reportingRepository: policy.repository }
      : {}),
  };
}

/** Credentials are captured by the trusted controller, never copied to a host or a session row. */
export function createBlackboardReporting(
  config: BlackboardConfig,
  options: {
    now?: () => string;
    nonce?: () => string;
    dependencies?: Parameters<typeof verifyFreshFeedback>[0]["dependencies"];
  } = {},
): BlackboardReporting {
  const dependencies = { loadClient: () => import("agent-blackboard"), ...options.dependencies };
  const env = { AGENT_BLACKBOARD_URL: config.url, AGENT_BLACKBOARD_TOKEN: config.token };
  const permitted = (session: SessionRecord) => {
    const policy = blackboardPolicy(
      config,
      session.repositoryId,
      session.principalId,
      session.workspacePoolId,
    );
    return (
      session.reportingMode === "autonomous" &&
      Boolean(
        policy &&
        policy.repository === session.reportingRepository &&
        session.reportingPolicyVersion,
      )
    );
  };
  const probe = async (
    session: SessionRecord,
    attemptId: string,
    stage: "assignment" | "command",
  ) => {
    if (
      !permitted(session) ||
      (stage === "assignment"
        ? session.status !== "queued"
        : session.status !== "running" || session.attemptId !== attemptId)
    )
      return false;
    try {
      await verifyFreshFeedback({
        identity: blackboardIdentity(session),
        env,
        timeoutMs: stage === "assignment" ? 2_000 : 15_000,
        dependencies,
        envelope: {
          schemaVersion: 1,
          type: "journal",
          sourceEventId: `${session.id}:${stage}-admission:${attemptId}:${(options.nonce ?? randomUUID)()}`,
          timestamp: (options.now ?? (() => new Date().toISOString()))(),
          repositories: [session.reportingRepository!],
          markdown: `Harness command admission for session ${session.id}, attempt ${attemptId}.`,
          workOutcome: "in-progress",
          feedbackCoverage: { status: "not-started", sources: [], droppedCount: 0 },
        },
      });
      return true;
    } catch {
      return false;
    }
  };
  return {
    config,
    requiresDurableStorage: true,
    authorizeAssignment: (session, attemptId) => probe(session, attemptId, "assignment"),
    authorize: (session, attemptId) => probe(session, attemptId, "command"),
    snapshot(session, sourceEventId) {
      const envelope = createFeedbackEnvelope(terminalFeedbackEnvelope(session, sourceEventId), {
        knownSensitiveValues: [config.token],
      });
      return {
        identity: blackboardIdentity(session),
        envelope,
        authorization: {
          repositoryId: session.repositoryId || null,
          ...(session.workspacePoolId ? { workspacePoolId: session.workspacePoolId } : {}),
          principalId: session.principalId ?? "system",
          policyVersion: session.reportingPolicyVersion!,
        },
      };
    },
    async deliver(request) {
      const snapshot = request.feedback;
      if (
        !snapshot ||
        snapshot.envelope.sourceEventId !== request.event.id ||
        snapshot.identity.sessionId !== request.event.subject.id ||
        snapshot.authorization.policyVersion !== request.destination.configurationVersion ||
        snapshot.authorization.repositoryId !== request.event.data.repositoryId ||
        snapshot.authorization.workspacePoolId !== (request.event.data.workspacePoolId ?? undefined)
      )
        return false;
      const policy = blackboardPolicy(
        config,
        snapshot.authorization.repositoryId ?? "",
        snapshot.authorization.principalId,
        snapshot.authorization.workspacePoolId,
      );
      if (
        !policy ||
        snapshot.envelope.repositories.length !== 1 ||
        snapshot.envelope.repositories[0] !== policy.repository
      )
        return false;
      const result = await writeFeedback({
        identity: snapshot.identity,
        envelope: snapshot.envelope,
        mode: "autonomous",
        env,
        timeoutMs: Math.min(
          20_000,
          Math.max(
            1,
            request.leaseExpiresAt
              ? Date.parse(request.leaseExpiresAt) - Date.now() - 1_000
              : 20_000,
          ),
        ),
        dependencies,
      });
      return result.status === "delivered";
    },
  };
}

export function blackboardTransport(reporting: BlackboardReporting): WebhookTransport {
  return {
    async deliver(request) {
      if (request.destination.configurationId !== BLACKBOARD_DESTINATION)
        return { ok: false, failureCode: "configuration-unavailable" };
      try {
        return (await reporting.deliver(request))
          ? { ok: true }
          : { ok: false, failureCode: "configuration-unavailable" };
      } catch {
        return { ok: false, failureCode: "transient-failure" };
      }
    },
  };
}
