import {
  ConditionalCheckFailedException,
  DeleteTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  conditionalCatalogWriteOrThrow,
  isActiveSession,
  putSchedule,
  scheduleAttributes,
  setRepositoryAdmissionState,
  skipScheduleForClosedRepository,
  tryClaimSchedule,
  tryClaimScheduleAndCreateSession,
  updateScheduleManagement,
  skipScheduleForActiveConcurrency,
} from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { nextPageKey } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `Ah69CatalogSchedule${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local schedule catalog adapters", () => {
  it("classifies conditional responses and schedule values", () => {
    expect(
      conditionalCatalogWriteOrThrow(
        new ConditionalCheckFailedException({ $metadata: {}, message: "conditional" }),
      ),
    ).toBe(false);
    expect(() => conditionalCatalogWriteOrThrow(new Error("unavailable"))).toThrow("unavailable");
    expect(nextPageKey(undefined)).toBeUndefined();
    expect(nextPageKey({})).toBeUndefined();
    expect(nextPageKey({ id: "next" })).toEqual({ id: "next" });
    expect(scheduleAttributes(undefined)).toBeNull();
    expect(scheduleAttributes({ id: "schedule" })).toEqual({ id: "schedule" });
    expect(isActiveSession(null)).toBe(false);
    expect(isActiveSession({ status: "queued" } as never)).toBe(true);
    expect(isActiveSession({ status: "running" } as never)).toBe(true);
    expect(isActiveSession({ status: "completed" } as never)).toBe(false);
  });

  it("fences scheduled writes", async () => {
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.repositories,
        Item: { id: "repository", name: "repository", url: "url", defaultBranch: "main" },
      }),
    );
    const schedule = {
      id: "schedule",
      repositoryId: "repository",
      name: "Schedule",
      target: { commandId: "command" },
      fallbacks: [],
      targetLabels: ["command"],
      cron: "* * * * *",
      enabled: true,
      timeout: 30,
      queueTtlSeconds: 60,
      nextRunAt: "one",
      lastRunAt: null,
      createdAt: "t",
    };
    await putSchedule(ctx, schedule);
    expect(await tryClaimSchedule(ctx, "schedule", "one", "two", "one")).toBe(true);
    expect(await tryClaimSchedule(ctx, "schedule", "one", "three", "one")).toBe(false);
    expect(
      await updateScheduleManagement(
        ctx,
        { ...schedule, nextRunAt: "four", ref: "main", concurrencyId: "concurrency" },
        "two",
      ),
    ).toMatchObject({ nextRunAt: "four", ref: "main" });
    expect(
      await updateScheduleManagement(ctx, { ...schedule, nextRunAt: "five" }, "two"),
    ).toBeNull();
    expect(
      await tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule",
        expectedNextRunAt: "four",
        newNextRunAt: "five",
        lastRunAt: "four",
        session: {
          id: "scheduled-session",
          repositoryId: "repository",
          prompt: "scheduled",
          target: { commandId: "command" },
          fallbacks: [],
          targetLabels: ["command"],
          queueTtlSeconds: 60,
          queueExpiresAt: "later",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          onConflict: "queue",
          status: "queued",
          queueShard: 0,
          createdAt: "t",
          concurrencyId: "concurrency",
        } as never,
      }),
    ).toEqual({ kind: "created" });
    expect(
      await skipScheduleForActiveConcurrency(ctx, {
        scheduleId: "schedule",
        expectedNextRunAt: "five",
        newNextRunAt: "six",
        concurrencyId: "concurrency",
        sessionId: "scheduled-session",
      }),
    ).toBe(true);
    expect(
      await skipScheduleForActiveConcurrency(ctx, {
        scheduleId: "schedule",
        expectedNextRunAt: "five",
        newNextRunAt: "seven",
        concurrencyId: "concurrency",
        sessionId: "scheduled-session",
      }),
    ).toBe(false);
    await ctx.doc.send(
      new DeleteCommand({ TableName: tables.sessions, Key: { id: "scheduled-session" } }),
    );
    await expect(
      tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule",
        expectedNextRunAt: "six",
        newNextRunAt: "seven",
        lastRunAt: "six",
        session: {
          id: "replacement-session",
          repositoryId: "repository",
          prompt: "scheduled",
          target: { commandId: "command" },
          fallbacks: [],
          targetLabels: ["command"],
          queueTtlSeconds: 60,
          queueExpiresAt: "later",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          onConflict: "queue",
          status: "queued",
          queueShard: 0,
          createdAt: "t",
          concurrencyId: "concurrency",
        } as never,
      }),
    ).resolves.toEqual({ kind: "lost" });
    await putSchedule(ctx, { ...schedule, id: "closed-schedule", nextRunAt: "closed-one" });
    expect(
      await setRepositoryAdmissionState(ctx, "repository", "paused", "closed-at"),
    ).not.toBeNull();
    expect(
      await skipScheduleForClosedRepository(ctx, {
        scheduleId: "closed-schedule",
        repositoryId: "repository",
        expectedNextRunAt: "closed-one",
        newNextRunAt: "closed-two",
      }),
    ).toBe(true);
    expect(
      await skipScheduleForClosedRepository(ctx, {
        scheduleId: "closed-schedule",
        repositoryId: "repository",
        expectedNextRunAt: "closed-one",
        newNextRunAt: "closed-three",
      }),
    ).toBe(false);
  });
});
