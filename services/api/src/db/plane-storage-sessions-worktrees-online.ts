import { TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  isConditionalTransactionFailed,
  type PlaneStorageCtx,
} from "./plane-storage-types.ts";
import { getWorktree } from "./plane-storage-sessions-worktrees.ts";

export async function releaseWorktree(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  opts?: { forceOffline?: boolean },
): Promise<void> {
  const wt = await getWorktree(ctx, worktreeId);
  if (!wt) {
    return;
  }
  const online = opts?.forceOffline ? false : wt.online;
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
      ExpressionAttributeNames: { "#s": "status", "#o": "online" },
      ExpressionAttributeValues: {
        ":idle": "idle",
        ":null": null,
        ":online": online,
      },
    }),
  );
}

export async function setWorktreeOnline(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  online: boolean,
): Promise<void> {
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.worktrees,
      Key: { id: worktreeId },
      UpdateExpression: "SET #o = :o",
      ExpressionAttributeNames: { "#o": "online" },
      ExpressionAttributeValues: { ":o": online },
    }),
  );
}

export async function setWorktreeOnlineFenced(
  ctx: PlaneStorageCtx,
  worktreeId: string,
  connectionId: string,
  online: boolean,
  fence?: { hostId: string; connectionId: string },
): Promise<boolean> {
  try {
    if (fence) {
      await ctx.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: ctx.tables.hostLocks,
                Key: { hostId: fence.hostId },
                ConditionExpression: "connectionId = :connectionId",
                ExpressionAttributeValues: { ":connectionId": fence.connectionId },
              },
            },
            {
              Update: {
                TableName: ctx.tables.worktrees,
                Key: { id: worktreeId },
                UpdateExpression: "SET #o = :online",
                ConditionExpression:
                  "attribute_not_exists(connectionId) OR connectionId = :connectionId",
                ExpressionAttributeNames: { "#o": "online" },
                ExpressionAttributeValues: { ":online": online, ":connectionId": connectionId },
              },
            },
          ],
        }),
      );
    } else {
      await ctx.doc.send(
        new UpdateCommand({
          TableName: ctx.tables.worktrees,
          Key: { id: worktreeId },
          UpdateExpression: "SET #o = :online",
          ConditionExpression: "attribute_not_exists(connectionId) OR connectionId = :connectionId",
          ExpressionAttributeNames: { "#o": "online" },
          ExpressionAttributeValues: { ":online": online, ":connectionId": connectionId },
        }),
      );
    }
    return true;
  } catch (err) {
    if (isConditionalFailed(err) || isConditionalTransactionFailed(err)) return false;
    throw err;
  }
}
