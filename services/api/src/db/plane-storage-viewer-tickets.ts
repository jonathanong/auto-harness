import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { isUserRole } from "@auto-harness/shared";

import {
  isConditionalFailed,
  type PlaneStorageCtx,
  type ViewerTicketRecord,
} from "./plane-storage-types.ts";

/** Persist a hashed viewer ticket. Colliding hashes fail closed. */
export async function putViewerTicket(
  ctx: PlaneStorageCtx,
  record: ViewerTicketRecord,
): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.viewerTickets,
      Item: {
        ticketHash: record.ticketHash,
        expiresAtMs: record.expiresAtMs,
        expiresAt: Math.ceil(record.expiresAtMs / 1000) + 60,
        id: record.principal.id,
        username: record.principal.username,
        role: record.principal.role,
        kind: record.principal.kind,
        ...(record.principal.allowedRepositoryIds
          ? { allowedRepositoryIds: record.principal.allowedRepositoryIds }
          : {}),
        ...(record.principal.boundHostId ? { boundHostId: record.principal.boundHostId } : {}),
      },
      ConditionExpression: "attribute_not_exists(ticketHash)",
    }),
  );
}

/** Delete and return a ticket only once. Missing, expired, and raced consumes yield null. */
export async function consumeViewerTicket(
  ctx: PlaneStorageCtx,
  ticketHash: string,
  nowMs: number,
): Promise<ViewerTicketRecord | null> {
  try {
    const result = await ctx.doc.send(
      new DeleteCommand({
        TableName: ctx.tables.viewerTickets,
        Key: { ticketHash },
        ConditionExpression: "attribute_exists(ticketHash)",
        ReturnValues: "ALL_OLD",
      }),
    );
    const item = result.Attributes;
    if (!item || typeof item.expiresAtMs !== "number" || item.expiresAtMs <= nowMs) return null;
    const principal = viewerTicketPrincipal(item);
    if (!principal) return null;
    return { ticketHash, principal, expiresAtMs: item.expiresAtMs };
  } catch (error) {
    if (isConditionalFailed(error)) return null;
    throw error;
  }
}

function viewerTicketPrincipal(
  item: Record<string, unknown>,
): ViewerTicketRecord["principal"] | null {
  if (
    typeof item.id !== "string" ||
    typeof item.username !== "string" ||
    !isUserRole(item.role) ||
    (item.kind !== "admin" && item.kind !== "user")
  ) {
    return null;
  }
  if (item.allowedRepositoryIds !== undefined && !stringArray(item.allowedRepositoryIds)) {
    return null;
  }
  if (item.boundHostId !== undefined && typeof item.boundHostId !== "string") return null;
  return {
    id: item.id,
    username: item.username,
    role: item.role,
    kind: item.kind,
    ...(item.allowedRepositoryIds ? { allowedRepositoryIds: item.allowedRepositoryIds } : {}),
    ...(item.boundHostId ? { boundHostId: item.boundHostId } : {}),
  };
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
