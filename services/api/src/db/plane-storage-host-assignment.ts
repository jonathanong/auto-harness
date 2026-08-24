import type { PlaneStorageCtx } from "./plane-storage-types.ts";

export type HostAssignmentLease = { hostId: string };

/** Increment the host's assignment count in the same transaction as the claim. */
export function hostAssignmentAcquireItem(
  ctx: PlaneStorageCtx,
  opts: { hostId: string; connectionId: string; cap: number },
) {
  return {
    Update: {
      TableName: ctx.tables.hostLocks,
      Key: { hostId: opts.hostId },
      UpdateExpression: "SET assignmentCount = if_not_exists(assignmentCount, :zero) + :one",
      ConditionExpression:
        "connectionId = :connectionId AND (attribute_not_exists(draining) OR draining = :false) AND (attribute_not_exists(assignmentCount) OR assignmentCount < :cap)",
      ExpressionAttributeValues: {
        ":connectionId": opts.connectionId,
        ":false": false,
        ":zero": 0,
        ":one": 1,
        ":cap": opts.cap,
      },
    },
  };
}

/** Release a reservation owned by a completed/requeued assignment. */
export function hostAssignmentReleaseItem(ctx: PlaneStorageCtx, lease: HostAssignmentLease) {
  return {
    Update: {
      TableName: ctx.tables.hostLocks,
      Key: { hostId: lease.hostId },
      UpdateExpression: "SET assignmentCount = assignmentCount - :one",
      ConditionExpression: "assignmentCount >= :one",
      ExpressionAttributeValues: { ":one": 1 },
    },
  };
}
