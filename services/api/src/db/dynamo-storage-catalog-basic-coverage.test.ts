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
  putSchedule,
  updateRepositorySettings,
} from "./plane-storage-catalog.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
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
    await putArchive(ctx, {
      key: "archive",
      contentType: "application/json",
      bodyBytes: 2,
      status: "complete",
      objectStored: true,
      updatedAt: deletionAt,
    });
    expect((await getArchive(ctx, "archive"))?.bodyBytes).toBe(2);
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

  it("conditions putHostInventory on the version it was read at", async () => {
    const hostId = "host-versioned";
    const record = (updatedAt: string, version: number) => ({
      hostId,
      updatedAt,
      repositories: [],
      providerAccounts: [],
      commandProfiles: {},
      version,
    });
    // No existing row: expectedVersion 0 means "no version seen yet" (the
    // condition also matches attribute_not_exists(version)) and must succeed.
    expect(await putHostInventory(ctx, record("t1", 1), undefined, 0)).toBe(true);
    expect((await getHostInventory(ctx, hostId))?.version).toBe(1);

    // Stale write: caller still thinks version is 0, but it's now 1 — rejected,
    // and the stored record is left untouched.
    expect(await putHostInventory(ctx, record("stale", 2), undefined, 0)).toBe(false);
    expect((await getHostInventory(ctx, hostId))?.updatedAt).toBe("t1");

    // Correct version: succeeds and advances the stored version.
    expect(await putHostInventory(ctx, record("t2", 2), undefined, 1)).toBe(true);
    expect((await getHostInventory(ctx, hostId))?.version).toBe(2);

    // Wrong positive expectedVersion: rejected.
    expect(await putHostInventory(ctx, record("stale2", 3), undefined, 1)).toBe(false);
    expect((await getHostInventory(ctx, hostId))?.updatedAt).toBe("t2");
  });

  it("covers catalog value helpers", () => {
    expect(catalogItem(undefined)).toBeNull();
    expect(catalogItem({ id: "item" })).toEqual({ id: "item" });
    expect(catalogPageItems(undefined)).toEqual([]);
    expect(catalogPageItems(["record"])).toEqual(["record"]);
  });

  it("transitions repository admission and skips closed cron cursors", async () => {
    const storage = new DynamoPlaneStorageBase(ctx.doc, tables);
    const repository = {
      id: "admission-repository",
      name: "Admission",
      url: "/admission",
      defaultBranch: "main",
      createdAt: "t0",
      updatedAt: "t0",
    };
    await putRepository(ctx, repository);
    expect(await storage.setRepositoryAdmissionState(repository.id, "paused", "t1")).toMatchObject({
      admissionState: "paused",
    });
    expect(
      await storage.setRepositoryAdmissionState(repository.id, "draining", "t2"),
    ).toMatchObject({ admissionState: "draining", drainRequestedAt: "t2" });
    expect(await storage.setRepositoryAdmissionState(repository.id, "active", "t3")).toBeNull();
    expect(await storage.completeRepositoryDrain(repository.id, "wrong", "t3")).toBeNull();
    expect(await storage.completeRepositoryDrain(repository.id, "t2", "t3")).toMatchObject({
      admissionState: "paused",
      drainCompletedAt: "t3",
    });
    const restartedDrain = await storage.setRepositoryAdmissionState(
      repository.id,
      "draining",
      "t4",
    );
    expect(restartedDrain).toMatchObject({ admissionState: "draining" });
    expect(restartedDrain).not.toHaveProperty("drainCompletedAt");
    expect(
      await updateRepositorySettings(ctx, repository.id, { name: "Admission updated" }, "t5"),
    ).toMatchObject({ name: "Admission updated", admissionState: "draining" });
    expect(
      await updateRepositorySettings(
        ctx,
        repository.id,
        {
          name: "Admission updated again",
          url: "/updated",
          defaultBranch: "trunk",
          setupScript: "echo setup",
          terminalHookScript: "echo done",
        },
        "t6",
      ),
    ).toMatchObject({
      name: "Admission updated again",
      url: "/updated",
      defaultBranch: "trunk",
      setupScript: "echo setup",
      terminalHookScript: "echo done",
      admissionState: "draining",
    });

    await putSchedule(ctx, {
      id: "closed-schedule",
      repositoryId: repository.id,
      name: "Closed",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      cron: "* * * * *",
      enabled: true,
      timeout: 60,
      queueTtlSeconds: 60,
      nextRunAt: "t1",
      lastRunAt: null,
      createdAt: "t0",
      concurrencyId: "closed-schedule",
    });
    const skip = {
      scheduleId: "closed-schedule",
      repositoryId: repository.id,
      expectedNextRunAt: "t1",
      newNextRunAt: "t2",
    };
    await storage.completeRepositoryDrain(repository.id, "t4", "t7");
    expect(await storage.setRepositoryAdmissionState(repository.id, "active", "t8")).toMatchObject({
      admissionState: "active",
    });
    // The create transaction already observed closed admission. Activation racing this
    // follow-up must not resurrect the occurrence as catch-up work.
    expect(await storage.skipScheduleForClosedRepository(skip)).toBe(true);
    expect(await storage.skipScheduleForClosedRepository(skip)).toBe(false);
  });
});
