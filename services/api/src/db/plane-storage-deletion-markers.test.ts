import { PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import {
  acquireDeletionMarker,
  principalExistsCheck,
  renewDeletionMarker,
} from "./plane-storage-deletion-markers.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const now = "2026-01-01T00:00:00.000Z";
const ctx = (send: (command: unknown) => Promise<unknown>): PlaneStorageCtx =>
  ({
    doc: { send } as never,
    tables: { concurrencyLocks: "Locks", users: "Users" } as never,
  }) as PlaneStorageCtx;

describe("Dynamo catalog deletion markers", () => {
  it("writes both human-readable and Dynamo TTL expiry values", async () => {
    const commands: unknown[] = [];
    const storage = ctx(async (command) => {
      commands.push(command);
      return {};
    });
    await expect(acquireDeletionMarker(storage, "command:cmd", "owner", now)).resolves.toBe(true);
    await expect(renewDeletionMarker(storage, "command:cmd", "owner", now)).resolves.toBe(true);
    const acquired = (commands[0] as PutCommand).input;
    expect(acquired.Item).toMatchObject({
      concurrencyId: "catalog-delete:command:cmd",
      expiresAt: "2026-01-01T00:00:30.000Z",
      ttl: 1_767_225_630,
    });
    const renewed = (commands[1] as UpdateCommand).input;
    expect(renewed.UpdateExpression).toContain("ttl = :ttl");
    expect(renewed.ExpressionAttributeValues).toMatchObject({ ":ttl": 1_767_225_630 });
  });

  it("does not require durable Users rows for system or bootstrap admin principals", () => {
    expect(
      principalExistsCheck(
        ctx(async () => ({})),
        undefined,
      ),
    ).toBeNull();
    expect(
      principalExistsCheck(
        ctx(async () => ({})),
        "system",
      ),
    ).toBeNull();
    expect(
      principalExistsCheck(
        ctx(async () => ({})),
        "admin:root",
      ),
    ).toBeNull();
    expect(
      principalExistsCheck(
        ctx(async () => ({})),
        "admin:operator",
      ),
    ).toBeNull();
    expect(
      principalExistsCheck(
        ctx(async () => ({})),
        "user:alice",
      ),
    ).toEqual({
      ConditionCheck: {
        TableName: "Users",
        Key: { id: "user:alice" },
        ConditionExpression: "attribute_exists(id)",
      },
    });
  });
});
