import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { isConditionalFailed, type PlaneStorageCtx } from "./plane-storage-types.ts";

/** A failed queue probe cannot overwrite a later running assignment. */
export async function recordBlackboardAdmissionBlock(
  ctx: PlaneStorageCtx,
  sessionId: string,
  blocked: boolean,
  attemptId?: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.sessions,
        Key: { id: sessionId },
        UpdateExpression: blocked
          ? "SET reportingAdmissionBlocked = :blocked"
          : "REMOVE reportingAdmissionBlocked",
        ConditionExpression: attemptId
          ? "#status = :running AND attemptId = :attempt AND primaryCommandStartState = :pending"
          : "#status = :queued",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ...(attemptId
            ? { ":running": "running", ":attempt": attemptId, ":pending": "pending" }
            : { ":queued": "queued" }),
          ...(blocked ? { ":blocked": true } : {}),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailed(error)) return false;
    throw error;
  }
}
