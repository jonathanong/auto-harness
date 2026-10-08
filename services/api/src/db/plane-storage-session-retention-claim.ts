import { randomUUID } from "node:crypto";
import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import { sessionRetentionEligible } from "./plane-storage-session-retention-eligibility.ts";
import { sessionPrincipalId } from "../control-plane-session-owner.ts";
import type { RetentionJob } from "./plane-storage-session-retention-types.ts";
import type { SessionRecord } from "./types.ts";

const JOB_SCOPE = "__retention#v1#jobs";
const WRITER_SETTLE_MS = 120_000;

export async function claimSessionRetention(
  ctx: PlaneStorageCtx,
  session: SessionRecord,
  now: string,
  retentionDays = 30,
): Promise<boolean> {
  if (!sessionRetentionEligible(session) || session.retentionToken) return false;
  const token = randomUUID();
  const readyAt = new Date(Date.parse(now) + WRITER_SETTLE_MS).toISOString();
  const principalId = sessionPrincipalId(session);
  const job: RetentionJob = {
    scopeKey: JOB_SCOPE,
    recordKey: `${readyAt}#${token}`,
    sessionId: session.id,
    repositoryId: session.repositoryId,
    ...(principalId ? { principalId } : {}),
    queueShard: session.queueShard,
    activityGeneration: session.attemptId ?? session.createdAt,
    createdAt: session.createdAt,
    completedAt: session.completedAt!,
    token,
    readyAt,
    retentionDays,
  };
  const absent = [
    "providerAccountLease",
    "hostAssignmentLease",
    "activeHostId",
    "reconnectDeadlineAt",
    "terminalHookHandoff",
    "retentionToken",
  ];
  const nullable = ["worktreeId", "workspaceSlotId"];
  const flags = ["mainCheckoutLease", "workspaceSlotLease"];
  const condition = [
    "#status = :status",
    "createdAt = :createdAt",
    "completedAt = :completedAt",
    ...absent.map((field) => `attribute_not_exists(${field})`),
    ...nullable.map(
      (field) => `(attribute_not_exists(${field}) OR attribute_type(${field}, :nullType))`,
    ),
    ...flags.map((field) => `(attribute_not_exists(${field}) OR ${field} = :false)`),
    "(attribute_not_exists(errorCode) OR errorCode <> :checkout OR (attribute_not_exists(terminalHookHandoffSettled) AND attribute_not_exists(terminalHookHandoffExpiredAt)) OR attribute_exists(terminalHookLifecycleEnqueuedAt))",
    "(attribute_not_exists(outputsUploadExpiresAt) OR outputsUploadExpiresAt <= :now)",
  ].join(" AND ");
  try {
    await ctx.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: ctx.tables.sessions,
              Key: { id: session.id },
              UpdateExpression:
                "SET retentionToken = :token, retentionClaimedAt = :now REMOVE sessionApiKeyHash",
              ConditionExpression: condition,
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: {
                ":status": session.status,
                ":createdAt": session.createdAt,
                ":completedAt": session.completedAt,
                ":token": token,
                ":now": now,
                ":nullType": "NULL",
                ":false": false,
                ":checkout": "checkout_fetch_failed",
              },
            },
          },
          {
            Put: {
              TableName: ctx.tables.sessionDrains,
              Item: job,
              ConditionExpression: "attribute_not_exists(scopeKey)",
            },
          },
          {
            Put: {
              TableName: ctx.tables.archives,
              Item: {
                key: `sessions/${session.id}/logs.jsonl.gz`,
                status: "expired",
                contentType: "application/gzip",
                bodyBytes: 0,
                objectStored: false,
                updatedAt: now,
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

export async function leaseSessionRetentionJob(
  ctx: PlaneStorageCtx,
  job: RetentionJob,
  now: string,
  owner: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessionDrains,
        Key: { scopeKey: job.scopeKey, recordKey: job.recordKey },
        UpdateExpression: "SET leaseOwner = :owner, leaseUntil = :until",
        ConditionExpression:
          "#token = :token AND (attribute_not_exists(leaseUntil) OR leaseUntil <= :now)",
        ExpressionAttributeNames: { "#token": "token" },
        ExpressionAttributeValues: {
          ":token": job.token,
          ":owner": owner,
          ":now": now,
          ":until": new Date(Date.parse(now) + 55_000).toISOString(),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}
