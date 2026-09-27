import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SessionTerminalStatus } from "@auto-harness/shared";
import type { SessionCursorV2 } from "../control-plane-session-cursor.ts";
import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

export type ReportingRepairCheckpoint = {
  schemaVersion: 1;
  status: SessionTerminalStatus;
  revision: number;
  owner: string;
  leaseUntil: string;
  cursor: SessionCursorV2["partitions"] | null;
};

/** Invalid/obsolete cursor data restarts the traversal; it never skips retained evidence. */
function cursor(value: unknown): ReportingRepairCheckpoint["cursor"] {
  if (!Array.isArray(value) || value.length > 256) return null;
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).length !== 3 ||
      typeof item.id !== "string" ||
      item.id.length > 512 ||
      typeof item.exhausted !== "boolean"
    )
      return null;
    if (
      item.checkpoint !== null &&
      (!item.checkpoint ||
        typeof item.checkpoint !== "object" ||
        Object.keys(item.checkpoint).length !== 3 ||
        Object.values(item.checkpoint).some(
          (part) => typeof part !== "string" || part.length > 512,
        ))
    )
      return null;
  }
  return structuredClone(value) as ReportingRepairCheckpoint["cursor"];
}

export async function claimReportingRepair(
  ctx: PlaneStorageCtx,
  status: SessionTerminalStatus,
  owner: string,
  now: string,
): Promise<ReportingRepairCheckpoint | null> {
  const read = await ctx.doc.send(
    new GetCommand({
      TableName: ctx.tables.reportingRepairCheckpoints,
      Key: { status },
      ConsistentRead: true,
    }),
  );
  const prior = read.Item;
  const revision =
    typeof prior?.revision === "number" &&
    Number.isSafeInteger(prior.revision) &&
    prior.revision >= 0 &&
    prior.revision < Number.MAX_SAFE_INTEGER
      ? prior.revision
      : 0;
  const leaseUntil = new Date(Date.parse(now) + 60_000).toISOString();
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.reportingRepairCheckpoints,
        Key: { status },
        UpdateExpression:
          "SET schemaVersion = :schema, revision = :next, leaseOwner = :owner, leaseUntil = :until",
        ConditionExpression:
          "(attribute_not_exists(leaseUntil) OR leaseUntil <= :now) AND " +
          (prior?.revision !== undefined ? "revision = :prior" : "attribute_not_exists(revision)"),
        ExpressionAttributeValues: {
          ":schema": 1,
          ":next": revision + 1,
          ":owner": owner,
          ":until": leaseUntil,
          ":now": now,
          ...(prior?.revision !== undefined ? { ":prior": prior.revision } : {}),
        },
      }),
    );
    return {
      schemaVersion: 1,
      status,
      revision: revision + 1,
      owner,
      leaseUntil,
      cursor: prior?.schemaVersion === 1 ? cursor(prior.cursor) : null,
    };
  } catch (error) {
    if (isConditionalFailed(error)) return null;
    throw error;
  }
}

export async function completeReportingRepair(
  ctx: PlaneStorageCtx,
  checkpoint: ReportingRepairCheckpoint,
  nextCursor: ReportingRepairCheckpoint["cursor"],
  now: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.reportingRepairCheckpoints,
        Key: { status: checkpoint.status },
        UpdateExpression: "SET #cursor = :cursor REMOVE leaseOwner, leaseUntil",
        ConditionExpression: "revision = :revision AND leaseOwner = :owner AND leaseUntil > :now",
        ExpressionAttributeNames: { "#cursor": "cursor" },
        ExpressionAttributeValues: {
          ":cursor": nextCursor,
          ":revision": checkpoint.revision,
          ":owner": checkpoint.owner,
          ":now": now,
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}
