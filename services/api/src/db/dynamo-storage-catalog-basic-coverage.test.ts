import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { acquireDeletionMarker } from "./plane-storage-deletion-markers.ts";
import {
  catalogItem,
  catalogPageItems,
  createRepository,
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
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `Ah69CatalogBasic${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local basic catalog adapters", () => {
  it("reads, lists, creates, and deletes the catalog records", async () => {
    expect(await listRepositories(ctx)).toEqual([]);
    expect(await listArchives(ctx)).toEqual([]);
    expect(await listHostInventories(ctx)).toEqual([]);
    const repository = {
      id: "repository",
      name: "Repository",
      url: "/repository",
      defaultBranch: "main",
      createdAt: "t",
      updatedAt: "t",
    };
    expect(await createRepository(ctx, repository)).toBe(true);
    expect(await createRepository(ctx, repository)).toBe(false);
    await putRepository(ctx, { ...repository, name: "Changed" });
    expect((await getRepository(ctx, repository.id))?.name).toBe("Changed");
    expect(await getRepository(ctx, "missing")).toBeNull();
    expect((await listRepositories(ctx)).map(({ id }) => id)).toContain(repository.id);
    const deletionAt = "2026-01-01T00:00:00.000Z";
    await acquireDeletionMarker(ctx, "repository:repository", "owner", deletionAt);
    await deleteRepository(ctx, repository.id, [
      { key: "repository:repository", owner: "owner", now: deletionAt },
    ]);
    await deleteRepository(ctx, "missing-repository");
    await putArchive(ctx, { key: "archive", body: "[]", contentType: "application/json" });
    expect((await getArchive(ctx, "archive"))?.body).toBe("[]");
    expect(await getArchive(ctx, "missing")).toBeNull();
    expect((await listArchives(ctx)).map(({ key }) => key)).toContain("archive");
    await putHostInventory(ctx, {
      hostId: "host",
      updatedAt: "t",
      repositories: [],
      commandProfiles: {},
    });
    expect((await getHostInventory(ctx, "host"))?.hostId).toBe("host");
    expect(await getHostInventory(ctx, "missing")).toBeNull();
    expect((await listHostInventories(ctx)).map(({ hostId }) => hostId)).toContain("host");
    await deleteHostInventory(ctx, "host");
  });

  it("covers catalog value helpers", () => {
    expect(catalogItem(undefined)).toBeNull();
    expect(catalogItem({ id: "item" })).toEqual({ id: "item" });
    expect(catalogPageItems(undefined)).toEqual([]);
    expect(catalogPageItems(["record"])).toEqual(["record"]);
  });
});
