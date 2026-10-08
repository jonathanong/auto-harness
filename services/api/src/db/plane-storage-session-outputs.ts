import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { PrepareSessionOutputsRequest } from "@auto-harness/shared";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { isConditionalTransactionFailed } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";
import type {
  SessionOutputManifest,
  SessionOutputPayload,
} from "./plane-storage-session-outputs-types.ts";
import {
  createSessionOutputManifest,
  requirePublishable,
  SessionOutputStoreError,
  sessionOutputFingerprint,
  sessionOutputCheck,
} from "./plane-storage-session-outputs-core.ts";
export class DynamoSessionOutputsStore {
  private readonly ctx: PlaneStorageCtx;
  constructor(ctx: PlaneStorageCtx) {
    this.ctx = ctx;
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.ctx.doc.send(
      new GetCommand({
        TableName: this.ctx.tables.sessions,
        Key: { id: sessionId },
        ConsistentRead: true,
      }),
    );
    return (result.Item as SessionRecord | undefined) ?? null;
  }

  async getManifest(sessionId: string): Promise<SessionOutputManifest | null> {
    const result = await this.ctx.doc.send(
      new GetCommand({
        TableName: this.ctx.tables.sessionOutputs,
        Key: { sessionId, recordKey: "manifest" },
        ConsistentRead: true,
      }),
    );
    return (result.Item as SessionOutputManifest | undefined) ?? null;
  }

  async getPayload(sessionId: string): Promise<SessionOutputPayload | null> {
    const result = await this.ctx.doc.send(
      new GetCommand({
        TableName: this.ctx.tables.sessionOutputs,
        Key: { sessionId, recordKey: "payload" },
        ConsistentRead: true,
      }),
    );
    return (result.Item as SessionOutputPayload | undefined) ?? null;
  }

  async prepare(
    sessionId: string,
    request: PrepareSessionOutputsRequest,
    hostId: string,
    now: string,
  ): Promise<SessionOutputManifest> {
    const session = requirePublishable(
      await this.getSession(sessionId),
      request.attemptId,
      hostId,
      now,
    );
    const digest = sessionOutputFingerprint(request);
    const existing = await this.getManifest(sessionId);
    if (existing) {
      if (existing.attemptId !== request.attemptId || existing.fingerprint !== digest) {
        throw new SessionOutputStoreError(
          "OUTPUT_CONFLICT",
          409,
          "session output manifest already exists",
        );
      }
      if (existing.artifactsState === "pending") {
        try {
          await this.ctx.doc.send(
            new TransactWriteCommand({
              TransactItems: [sessionOutputCheck(this.ctx, session, hostId, now, true)],
            }),
          );
        } catch (error) {
          if (isConditionalTransactionFailed(error))
            throw new SessionOutputStoreError("STALE_ATTEMPT", 409, "session output fence changed");
          throw error;
        }
      }
      return existing;
    }
    const manifest = createSessionOutputManifest(sessionId, request, now);
    const items = [
      sessionOutputCheck(this.ctx, session, hostId, now, request.artifacts.state === "pending"),
      {
        Put: {
          TableName: this.ctx.tables.sessionOutputs,
          Item: manifest,
          ConditionExpression: "attribute_not_exists(sessionId)",
        },
      },
      ...(request.output.state === "ready"
        ? [
            {
              Put: {
                TableName: this.ctx.tables.sessionOutputs,
                Item: {
                  sessionId,
                  recordKey: "payload",
                  attemptId: request.attemptId,
                  jsonText: request.output.jsonText,
                  sha256: request.output.sha256,
                },
                ConditionExpression: "attribute_not_exists(sessionId)",
              },
            },
          ]
        : []),
    ];
    try {
      await this.ctx.doc.send(new TransactWriteCommand({ TransactItems: items }));
      return manifest;
    } catch (error) {
      if (!isConditionalTransactionFailed(error)) throw error;
      const winner = await this.getManifest(sessionId);
      if (winner?.attemptId === request.attemptId && winner.fingerprint === digest) return winner;
      if (winner)
        throw new SessionOutputStoreError(
          "OUTPUT_CONFLICT",
          409,
          "session output manifest already exists",
        );
      throw new SessionOutputStoreError("STALE_ATTEMPT", 409, "session output fence changed");
    }
  }

  async complete(
    sessionId: string,
    attemptId: string,
    hostId: string,
    now: string,
    artifact?: { key: string; versionId: string },
  ): Promise<SessionOutputManifest> {
    const session = requirePublishable(await this.getSession(sessionId), attemptId, hostId, now);
    const manifest = await this.getManifest(sessionId);
    if (!manifest || manifest.attemptId !== attemptId)
      throw new SessionOutputStoreError(
        "OUTPUTS_NOT_PREPARED",
        409,
        "session outputs are not prepared",
      );
    if (
      manifest.artifactsState === "ready" ||
      (manifest.completedAt && manifest.artifactsState !== "pending")
    )
      return manifest;
    if (manifest.artifactsState === "pending" && !artifact)
      throw new SessionOutputStoreError(
        "OUTPUTS_NOT_UPLOADED",
        409,
        "artifact upload is not verified",
      );
    try {
      await this.ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            sessionOutputCheck(this.ctx, session, hostId, now, false),
            {
              Update: {
                TableName: this.ctx.tables.sessionOutputs,
                Key: { sessionId, recordKey: "manifest" },
                UpdateExpression:
                  manifest.artifactsState === "pending"
                    ? "SET artifactsState = :ready, objectKey = :key, objectVersionId = :version, completedAt = :now"
                    : "SET completedAt = :now",
                ConditionExpression:
                  "attemptId = :attempt AND fingerprint = :fingerprint AND attribute_not_exists(completedAt)",
                ExpressionAttributeValues: {
                  ":attempt": attemptId,
                  ":fingerprint": manifest.fingerprint,
                  ":now": now,
                  ...(artifact
                    ? { ":ready": "ready", ":key": artifact.key, ":version": artifact.versionId }
                    : {}),
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalTransactionFailed(error)) throw error;
      const winner = await this.getManifest(sessionId);
      if (winner?.attemptId === attemptId && winner.completedAt) return winner;
      throw new SessionOutputStoreError("STALE_ATTEMPT", 409, "session output fence changed");
    }
    return (await this.getManifest(sessionId))!;
  }
}
