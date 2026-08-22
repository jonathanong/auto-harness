import { parseHostInventory } from "@auto-harness/shared";

import type { HostInventoryRecord } from "./db/plane-storage.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseHostBody(
  hostId: string,
  body: unknown,
): Omit<HostInventoryRecord, "updatedAt"> {
  if (!isRecord(body)) {
    throw new Error("body must be an object");
  }
  if (body.hostId !== undefined && body.hostId !== hostId) {
    throw new Error("body.hostId must match path hostId");
  }
  const inventory = parseHostInventory(body);

  return {
    hostId,
    ...inventory,
  };
}
