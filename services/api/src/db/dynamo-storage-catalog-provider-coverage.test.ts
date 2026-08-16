import {
  ConditionalCheckFailedException,
  DeleteTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  clearProviderAccountUsageLimit,
  updateProviderAccount,
} from "./plane-storage-provider-account-updates.ts";
import {
  deleteProviderAccount,
  getProviderAccount,
  listProviderAccounts,
  putProviderAccount,
} from "./plane-storage-provider-accounts.ts";
import { acquireDeletionMarker } from "./plane-storage-deletion-markers.ts";
import {
  conditionalProviderWriteOrThrow,
  deleteCommand,
  deleteProvider,
  getCommand,
  getProvider,
  listCommands,
  listProviders,
  pageItems,
  putCommand,
  putProvider,
} from "./plane-storage-catalog-providers.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { nextPageKey } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `Ah69CatalogProvider${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local provider catalog adapters", () => {
  it("maintains provider account and command rows with conditional updates", async () => {
    expect(await listProviders(ctx)).toEqual([]);
    expect(await listProviderAccounts(ctx)).toEqual([]);
    expect(await listCommands(ctx)).toEqual([]);
    await putProvider(ctx, {
      id: "provider",
      name: "Provider",
      defaultCommandId: null,
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await getProvider(ctx, "provider"))?.id).toBe("provider");
    expect(await getProvider(ctx, "missing")).toBeNull();
    await putProviderAccount(ctx, {
      id: "account",
      providerId: "provider",
      label: "first",
      createdAt: "t",
      updatedAt: "t",
    });
    expect(
      await updateProviderAccount(ctx, {
        id: "account",
        expectedVersion: 1,
        updatedAt: "t2",
        patch: { label: "second", usageLimitCooldownSeconds: 30, usageLimitedUntil: "later" },
      }),
    ).toBe(true);
    expect(
      await clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 2,
        expectedUsageLimitedUntil: "later",
        updatedAt: "t3",
      }),
    ).toBe(true);
    expect(
      await updateProviderAccount(ctx, {
        id: "account",
        expectedVersion: 1,
        updatedAt: "t4",
        patch: { label: "never" },
      }),
    ).toBe(false);
    expect(
      await clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedVersion: 3,
        expectedUsageLimitedUntil: "later",
        updatedAt: "t4",
      }),
    ).toBe(false);
    expect((await getProviderAccount(ctx, "account"))?.label).toBe("second");
    expect(await getProviderAccount(ctx, "missing")).toBeNull();
    expect((await listProviderAccounts(ctx)).map(({ id }) => id)).toContain("account");
    await deleteProviderAccount(ctx, "account");
    await putCommand(ctx, {
      id: "command",
      name: "Command",
      argv: ["echo"],
      appendPrompt: false,
      providerId: "provider",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await getCommand(ctx, "command"))?.argv).toEqual(["echo"]);
    expect(await getCommand(ctx, "missing")).toBeNull();
    expect((await listCommands(ctx)).map(({ id }) => id)).toContain("command");
    const deletionAt = "2026-01-01T00:00:00.000Z";
    await acquireDeletionMarker(ctx, "command:command", "owner", deletionAt);
    await deleteCommand(ctx, "command", [
      { key: "command:command", owner: "owner", now: deletionAt },
    ]);
    await deleteCommand(ctx, "missing-command");
    expect(await deleteProvider(ctx, "provider")).toBe(true);
    expect(await deleteProvider(ctx, "missing-provider")).toBe(false);
  });

  it("classifies provider conditional responses and pages", () => {
    expect(
      conditionalProviderWriteOrThrow(
        new ConditionalCheckFailedException({ $metadata: {}, message: "conditional" }),
      ),
    ).toBe(false);
    expect(() => conditionalProviderWriteOrThrow(new Error("unavailable"))).toThrow("unavailable");
    expect(pageItems(undefined)).toEqual([]);
    expect(pageItems(["provider"])).toEqual(["provider"]);
    expect(nextPageKey(undefined)).toBeUndefined();
    expect(nextPageKey({})).toBeUndefined();
    expect(nextPageKey({ id: "next" })).toEqual({ id: "next" });
  });
});
