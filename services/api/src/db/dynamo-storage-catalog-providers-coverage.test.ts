import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  deleteHostInventory,
  deleteRepository,
  getArchive,
  getHostInventory,
  getRepository,
  listArchives,
  listHostInventories,
  listRepositories,
  putArchive,
  putHostInventory,
  putRepository,
} from "./plane-storage-catalog.ts";
import {
  clearProviderAccountUsageLimit,
  deleteCommand,
  deleteProvider,
  deleteProviderAccount,
  getCommand,
  getProvider,
  getProviderAccount,
  listCommands,
  listProviders,
  listProviderAccounts,
  putCommand,
  putProvider,
  putProviderAccount,
  updateProviderAccount,
} from "./plane-storage-catalog-providers.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let ctx: PlaneStorageCtx;
let client: DynamoDBClient;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhCatalog${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local catalog and providers", () => {
  it("persists catalog records through their direct adapters", async () => {
    expect(await listRepositories(ctx)).toEqual([]);
    expect(await listArchives(ctx)).toEqual([]);
    expect(await listHostInventories(ctx)).toEqual([]);
    await putRepository(ctx, {
      id: "repository",
      name: "Repository",
      url: "/repository",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await getRepository(ctx, "repository"))?.name).toBe("Repository");
    expect(await getRepository(ctx, "missing")).toBeNull();
    expect((await listRepositories(ctx)).map((item) => item.id)).toContain("repository");
    await deleteRepository(ctx, "repository");

    await putArchive(ctx, { key: "archive", body: "[]", contentType: "application/json" });
    expect((await getArchive(ctx, "archive"))?.body).toBe("[]");
    expect(await getArchive(ctx, "missing")).toBeNull();
    expect((await listArchives(ctx)).map((item) => item.key)).toContain("archive");
    await putHostInventory(ctx, {
      hostId: "inventory-host",
      updatedAt: "t",
      repositories: [],
      commandProfiles: {},
    });
    expect((await getHostInventory(ctx, "inventory-host"))?.hostId).toBe("inventory-host");
    expect(await getHostInventory(ctx, "missing")).toBeNull();
    expect((await listHostInventories(ctx)).map((item) => item.hostId)).toContain("inventory-host");
    await deleteHostInventory(ctx, "inventory-host");
  });

  it("persists provider records and conditionally edits account state", async () => {
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
    expect((await listProviders(ctx)).map((item) => item.id)).toContain("provider");
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
        expectedUpdatedAt: "t",
        updatedAt: "t2",
        patch: {
          providerId: "other-provider",
          label: "second",
          usageLimitCooldownSeconds: 30,
          usageLimitedUntil: "2026-01-02T00:00:00.000Z",
        },
      }),
    ).toBe(true);
    expect(
      await clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedUpdatedAt: "t2",
        expectedUsageLimitedUntil: "2026-01-02T00:00:00.000Z",
        updatedAt: "t3",
      }),
    ).toBe(true);
    expect(
      await updateProviderAccount(ctx, {
        id: "account",
        expectedUpdatedAt: "stale",
        updatedAt: "t4",
        patch: { label: "never" },
      }),
    ).toBe(false);
    expect(
      await clearProviderAccountUsageLimit(ctx, {
        id: "account",
        expectedUpdatedAt: "t3",
        expectedUsageLimitedUntil: "unexpected",
        updatedAt: "t4",
      }),
    ).toBe(false);
    expect((await getProviderAccount(ctx, "account"))?.label).toBe("second");
    expect(await getProviderAccount(ctx, "missing")).toBeNull();
    expect((await listProviderAccounts(ctx)).map((item) => item.id)).toContain("account");
    await deleteProviderAccount(ctx, "account");

    await putCommand(ctx, {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: false,
      providerId: "provider",
      createdAt: "t",
      updatedAt: "t",
    });
    expect((await getCommand(ctx, "command"))?.argv).toEqual(["echo"]);
    expect(await getCommand(ctx, "missing")).toBeNull();
    expect((await listCommands(ctx)).map((item) => item.id)).toContain("command");
    await deleteCommand(ctx, "command");
    await deleteProvider(ctx, "provider");
  });
});
