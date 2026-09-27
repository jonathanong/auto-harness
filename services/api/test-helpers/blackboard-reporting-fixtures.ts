import type { SessionRecord } from "../src/db/types.ts";

export const NOW = "2026-09-27T20:00:00.000Z";
export const ARN =
  "arn:aws:dynamodb:us-east-1:123456789012:table/test-Sessions/stream/2026-09-27T00:00:00.000";
export function config(url = "https://blackboard.example.test") {
  return {
    schemaVersion: 1 as const,
    version: 1,
    url,
    token: "test-writer-credential",
    policies: [
      { repositoryId: "repo", repository: "owner/repo", principalIds: ["user:operator", "system"] },
    ],
  };
}
export function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "session",
    repositoryId: "repo",
    principalId: "user:operator",
    prompt: "private prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: NOW,
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "running",
    queueShard: 0,
    createdAt: NOW,
    hostId: "host",
    worktreeId: "worktree",
    attemptId: "attempt",
    primaryCommandStartState: "pending",
    reportingMode: "autonomous",
    reportingPolicyVersion: 1,
    reportingRepository: "owner/repo",
    reportingAgentVersion: "test-build",
    ...overrides,
  };
}
export function terminal(overrides: Partial<SessionRecord> = {}) {
  return session({
    status: "completed",
    completedAt: NOW,
    worktreeId: null,
    result: {
      summary: "private output",
      summarySource: "agent",
      feedback: {
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
          sandbox:
            "Inspected this attempt authorization and execution boundary; no issue observed.",
          tools: "No additional workflow tool was applicable to this scoped command.",
        },
        toolAssessments: [],
        findings: [],
        droppedCount: 0,
      },
    },
    ...overrides,
  });
}
function attribute(value: unknown): Record<string, unknown> {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  if (typeof value === "object" && value)
    return {
      M: Object.fromEntries(
        Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .map(([key, child]) => [key, attribute(child)]),
      ),
    };
  throw new Error("unsupported test attribute");
}
export function event(row: SessionRecord, sequence = "1") {
  return {
    Records: [
      {
        eventSource: "aws:dynamodb",
        eventSourceARN: ARN,
        eventName: "MODIFY",
        dynamodb: {
          Keys: { id: { S: row.id } },
          SequenceNumber: sequence,
          NewImage: Object.fromEntries(
            Object.entries(row)
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => [key, attribute(value)]),
          ),
        },
      },
    ],
  };
}
