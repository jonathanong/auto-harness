import { createHash } from "node:crypto";
import {
  SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS,
  SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS,
  SESSION_OUTPUT_RETRY_WINDOW_MS,
  type PrepareSessionOutputsRequest,
} from "@auto-harness/shared";

import type { SessionRecord } from "./types.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionOutputManifest } from "./plane-storage-session-outputs-types.ts";

export class SessionOutputStoreError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
const uploadWindowMs =
  SESSION_ARTIFACT_UPLOAD_URL_TTL_SECONDS * 1000 + SESSION_ARTIFACT_UPLOAD_TIMEOUT_MS + 10_000;

export function sessionOutputFingerprint(request: PrepareSessionOutputsRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

export function createSessionOutputManifest(
  sessionId: string,
  request: PrepareSessionOutputsRequest,
  now: string,
): SessionOutputManifest {
  return {
    sessionId,
    recordKey: "manifest",
    attemptId: request.attemptId,
    capturedAt: request.capturedAt,
    fingerprint: sessionOutputFingerprint(request),
    outputState: request.output.state,
    ...(request.output.state === "error" ? { outputError: request.output.error } : {}),
    artifactsState: request.artifacts.state,
    ...(request.artifacts.state === "error" ? { artifactsError: request.artifacts.error } : {}),
    ...(request.artifacts.state === "pending"
      ? {
          compressedBytes: request.artifacts.compressedBytes,
          sourceBytes: request.artifacts.sourceBytes,
          fileCount: request.artifacts.fileCount,
          sha256: request.artifacts.sha256,
        }
      : {}),
    preparedAt: now,
  };
}

export function requirePublishable(
  session: SessionRecord | null,
  attemptId: string,
  hostId: string | undefined,
  now: string,
): SessionRecord {
  if (
    !session ||
    !session.sessionOutputsSupported ||
    !session.attemptId ||
    !session.resolvedRoute
  ) {
    throw new SessionOutputStoreError(
      "STALE_ATTEMPT",
      409,
      "session output attempt is unavailable",
    );
  }
  if (session.attemptId !== attemptId || session.resolvedRoute.hostId !== hostId) {
    throw new SessionOutputStoreError("STALE_ATTEMPT", 409, "session output attempt is stale");
  }
  if (session.retentionToken)
    throw new SessionOutputStoreError("RETENTION_STARTED", 410, "session retention has started");
  if (!terminal.has(session.status) || session.terminalHookHandoff) {
    throw new SessionOutputStoreError("OUTPUTS_NOT_SETTLED", 409, "session outcome is not settled");
  }
  if (
    !session.completedAt ||
    Date.parse(now) > Date.parse(session.completedAt) + SESSION_OUTPUT_RETRY_WINDOW_MS
  ) {
    throw new SessionOutputStoreError(
      "OUTPUTS_EXPIRED",
      410,
      "session output retry window expired",
    );
  }
  return session;
}

export function sessionOutputCheck(
  ctx: PlaneStorageCtx,
  session: SessionRecord,
  hostId: string,
  now: string,
  upload: boolean,
) {
  const common = {
    TableName: ctx.tables.sessions,
    Key: { id: session.id },
    ConditionExpression:
      "attemptId = :attempt AND resolvedRoute.hostId = :host AND createdAt = :created AND #status = :status AND completedAt = :completed AND sessionOutputsSupported = :supported AND attribute_not_exists(retentionToken) AND attribute_not_exists(terminalHookHandoff) AND completedAt >= :cutoff",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":attempt": session.attemptId,
      ":host": hostId,
      ":created": session.createdAt,
      ":status": session.status,
      ":completed": session.completedAt,
      ":supported": true,
      ":cutoff": new Date(Date.parse(now) - SESSION_OUTPUT_RETRY_WINDOW_MS).toISOString(),
      ...(upload ? { ":until": new Date(Date.parse(now) + uploadWindowMs).toISOString() } : {}),
    },
  };
  return upload
    ? { Update: { ...common, UpdateExpression: "SET outputsUploadExpiresAt = :until" } }
    : { ConditionCheck: common };
}
