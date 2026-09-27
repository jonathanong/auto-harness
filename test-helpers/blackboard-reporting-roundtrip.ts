import type { ControlPlane } from "../services/api/src/control-plane.ts";
import type { DynamoPlaneStorage } from "../services/api/src/db/plane-storage.ts";
import {
  putActiveTestRepository,
  putTestPrincipal,
} from "../services/api/test-helpers/dynamo-test-helpers.ts";

export function attribute(value: unknown): {
  S?: string;
  N?: string;
  NULL?: boolean;
  BOOL?: boolean;
  L?: ReturnType<typeof attribute>[];
  M?: Record<string, ReturnType<typeof attribute>>;
} {
  if (value === null) return { NULL: true };
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (typeof value === "boolean") return { BOOL: value };
  if (Array.isArray(value)) return { L: value.map(attribute) };
  if (typeof value === "object" && value)
    return {
      M: Object.fromEntries(
        Object.entries(value)
          .filter(([, child]) => child !== undefined)
          .map(([key, child]) => [key, attribute(child)]),
      ),
    };
  throw new Error("unsupported fixture attribute");
}
export const NOW = "2026-09-27T20:00:00.000Z";
export const ARN =
  "arn:aws:dynamodb:us-east-1:123456789012:table/test-Sessions/stream/2026-09-27T00:00:00.000";
export const feedback = {
  schemaVersion: 1,
  completionKind: "no-change",
  feedbackCoverage: "complete",
  assessments: { architecture: "none-observed", sandbox: "none-observed", tools: "none-observed" },
  assessmentEvidence: {
    architecture: "Inspected the command's module boundary; no coupling issue observed.",
    sandbox: "Inspected admission and execution for this attempt; no denial observed.",
    tools: "No additional workflow tool applies to this read-only inspection.",
  },
  toolAssessments: [],
  findings: [],
  droppedCount: 0,
};

export async function seed(plane: ControlPlane, storage: DynamoPlaneStorage) {
  await putActiveTestRepository(storage, "repo");
  await putTestPrincipal(storage, "operator");
  await storage.putCommand({
    id: "command",
    name: "codex",
    argv: ["codex", "exec"],
    appendPrompt: true,
    providerId: null,
    resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}", "--model", "example"],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await plane.hydrateFromStorage();
}
