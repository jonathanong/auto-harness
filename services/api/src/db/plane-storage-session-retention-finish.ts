import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

import { sessionDrainActivityForScope } from "./plane-storage-session-drain-activity.ts";
import {
  activeActivityForAssignment,
  repositoryActivityForSession,
} from "./plane-storage-operational-activity.ts";
import { isConditionalTransactionFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";
import { SESSION_DELETION_FENCE_SCOPE } from "./plane-storage-session-retention-eligibility.ts";
import type { RetentionJob } from "./plane-storage-session-retention-types.ts";

export async function finishSessionRetentionJob(
  ctx: PlaneStorageCtx,
  job: RetentionJob,
  owner: string,
  now: string,
): Promise<boolean> {
  const repositoryActivity = repositoryActivityForSession({
    id: job.sessionId,
    repositoryId: job.repositoryId,
    createdAt: job.createdAt,
  });
  const activeActivity = activeActivityForAssignment({
    sessionId: job.sessionId,
    repositoryId: job.repositoryId,
    queueShard: job.queueShard,
    attemptId: job.activityGeneration,
  });
  const principalActivity = job.principalId
    ? sessionDrainActivityForScope(job.repositoryId, job.principalId, job.sessionId)
    : null;
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: ctx.tables.sessions,
              Key: { id: job.sessionId },
              ConditionExpression:
                "retentionToken = :token AND createdAt = :createdAt AND completedAt = :completedAt",
              ExpressionAttributeValues: {
                ":token": job.token,
                ":createdAt": job.createdAt,
                ":completedAt": job.completedAt,
              },
            },
          },
          {
            Delete: {
              TableName: ctx.tables.archives,
              Key: { key: `sessions/${job.sessionId}/logs.jsonl.gz` },
            },
          },
          ...(repositoryActivity
            ? [
                {
                  Delete: {
                    TableName: ctx.tables.sessionDrains,
                    Key: {
                      scopeKey: repositoryActivity.scopeKey,
                      recordKey: repositoryActivity.recordKey,
                    },
                    ConditionExpression:
                      "attribute_not_exists(scopeKey) OR (recordType = :type AND sessionId = :sessionId AND generation = :generation)",
                    ExpressionAttributeValues: {
                      ":type": repositoryActivity.recordType,
                      ":sessionId": job.sessionId,
                      ":generation": job.createdAt,
                    },
                  },
                },
              ]
            : []),
          {
            Delete: {
              TableName: ctx.tables.sessionDrains,
              Key: { scopeKey: activeActivity.scopeKey, recordKey: activeActivity.recordKey },
              ConditionExpression:
                "attribute_not_exists(scopeKey) OR (recordType = :type AND sessionId = :sessionId AND generation = :generation)",
              ExpressionAttributeValues: {
                ":type": activeActivity.recordType,
                ":sessionId": job.sessionId,
                ":generation": job.activityGeneration,
              },
            },
          },
          ...(principalActivity
            ? [
                {
                  Delete: {
                    TableName: ctx.tables.sessionDrains,
                    Key: {
                      scopeKey: principalActivity.scopeKey,
                      recordKey: principalActivity.recordKey,
                    },
                    ConditionExpression:
                      "attribute_not_exists(scopeKey) OR (recordType = :type AND sessionId = :sessionId AND repositoryId = :repositoryId AND principalId = :principalId)",
                    ExpressionAttributeValues: {
                      ":type": "activity",
                      ":sessionId": job.sessionId,
                      ":repositoryId": job.repositoryId,
                      ":principalId": job.principalId,
                    },
                  },
                },
              ]
            : []),
          {
            Delete: {
              TableName: ctx.tables.sessionDrains,
              Key: { scopeKey: job.scopeKey, recordKey: job.recordKey },
              ConditionExpression: "#token = :token AND leaseOwner = :owner",
              ExpressionAttributeNames: { "#token": "token" },
              ExpressionAttributeValues: { ":token": job.token, ":owner": owner },
            },
          },
          {
            Put: {
              TableName: ctx.tables.sessionDrains,
              Item: {
                scopeKey: SESSION_DELETION_FENCE_SCOPE,
                recordKey: job.sessionId,
                createdAt: job.createdAt,
                deletedAt: now,
                ttl: Math.floor(Date.parse(now) / 1000) + job.retentionDays * 86_400,
              },
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalTransactionFailed(error)) return false;
    throw error;
  }
}
