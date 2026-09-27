import { isSessionFeedback, isTerminalSessionStatus } from "@auto-harness/shared";
import type { BlackboardTerminalSnapshot } from "./blackboard-reporting.ts";

type Attribute = {
  S?: string;
  N?: string;
  M?: Record<string, Attribute>;
  L?: Attribute[];
  NULL?: boolean;
};
export type StreamRecord = {
  eventSource?: string;
  eventSourceARN?: string;
  eventName?: string;
  dynamodb?: {
    Keys?: { id?: Attribute };
    SequenceNumber?: string;
    NewImage?: Record<string, Attribute>;
  };
};

/** Decode only the bounded evidence member, never the full session image/prompt/metadata/logs. */
function feedbackValue(attribute: Attribute, budget: { nodes: number }, depth = 0): unknown {
  if (++budget.nodes > 256 || depth > 5) throw new Error("oversized Blackboard stream evidence");
  if (attribute.S !== undefined) {
    if (Buffer.byteLength(attribute.S) > 256)
      throw new Error("oversized Blackboard stream evidence");
    return attribute.S;
  }
  if (attribute.N !== undefined) return Number(attribute.N);
  if (attribute.M)
    return Object.fromEntries(
      Object.entries(attribute.M).map(([key, value]) => [
        key,
        feedbackValue(value, budget, depth + 1),
      ]),
    );
  if (attribute.L) return attribute.L.map((value) => feedbackValue(value, budget, depth + 1));
  throw new Error("invalid Blackboard stream evidence");
}

/** The committed stream image preserves old outcomes even if a later attempt already changed the live row. */
export function terminalSnapshotFromStream(
  record: StreamRecord,
): BlackboardTerminalSnapshot | undefined {
  const image = record.dynamodb?.NewImage;
  const status = image?.status?.S;
  if (!image || !status || !isTerminalSessionStatus(status as never)) return undefined;
  if (image.terminalHookHandoff?.M || image.activeHostId?.S || image.assignmentConnectionId?.S)
    return undefined;
  const id = image.id?.S;
  const repositoryId = image.repositoryId?.S;
  const completedAt = image.completedAt?.S;
  if (
    !id ||
    repositoryId === undefined ||
    (!repositoryId && !image.workspacePoolId?.S) ||
    !completedAt ||
    !Number.isFinite(Date.parse(completedAt)) ||
    image.reportingMode?.S !== "autonomous"
  )
    return undefined;
  const snapshot: BlackboardTerminalSnapshot = {
    id,
    repositoryId,
    status: status as BlackboardTerminalSnapshot["status"],
    completedAt,
    reportingMode: "autonomous",
  };
  for (const key of [
    "workspacePoolId",
    "principalId",
    "parentSessionId",
    "attemptId",
    "reportingRepository",
    "reportingAgentVersion",
  ] as const) {
    const value = image[key]?.S;
    if (value !== undefined && value.length <= 512) snapshot[key] = value;
  }
  const version = Number(image.reportingPolicyVersion?.N);
  if (Number.isSafeInteger(version) && version > 0) snapshot.reportingPolicyVersion = version;
  const feedback = image.result?.M?.feedback;
  if (feedback) {
    try {
      const value = feedbackValue(feedback, { nodes: 0 });
      if (isSessionFeedback(value)) snapshot.result = { feedback: value };
    } catch {
      /* Invalid evidence is honestly unavailable; the terminal event still survives. */
    }
  }
  return snapshot;
}
