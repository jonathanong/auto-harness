import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  createRepository,
  completeRepositoryDrain,
  putLogFenced,
  putLogsFenced,
  skipScheduleForActiveConcurrency,
  setRepositoryAdmissionState,
  tryClaimSchedule,
  tryClaimScheduleAndCreateSession,
  updateScheduleManagement,
} from "./plane-storage-catalog.ts";
let client: DynamoDBClient;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `Ah69CatalogErrors${process.pid}` });
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local catalog transport failures", () => {
  it("reports real DynamoDB transport failures", async () => {
    const unavailable = createDynamoClients({ endpoint: "http://127.0.0.1:7468" });
    const unavailableCtx = { doc: unavailable.doc, tables };
    await expect(
      putLogFenced(unavailableCtx, {} as never, { hostId: "host", connectionId: "connection" }),
    ).rejects.toThrow();
    await expect(
      putLogsFenced(unavailableCtx, [{} as never], {
        hostId: "host",
        connectionId: "connection",
      }),
    ).rejects.toThrow();
    await expect(
      createRepository(unavailableCtx, {
        id: "repository",
        name: "Repository",
        url: "/repository",
        defaultBranch: "main",
        createdAt: "t",
        updatedAt: "t",
      }),
    ).rejects.toThrow();
    await expect(
      setRepositoryAdmissionState(unavailableCtx, "repository", "paused", "t"),
    ).rejects.toThrow();
    await expect(
      completeRepositoryDrain(unavailableCtx, "repository", "requested", "t"),
    ).rejects.toThrow();
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
    await expect(updateScheduleManagement(unavailableCtx, schedule, "one")).rejects.toThrow();
    await expect(
      tryClaimSchedule(unavailableCtx, "schedule", "one", "two", "one"),
    ).rejects.toThrow();
    await expect(
      tryClaimScheduleAndCreateSession(unavailableCtx, {
        scheduleId: "schedule",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        lastRunAt: "one",
        session: {} as never,
      }),
    ).rejects.toThrow();
    await expect(
      skipScheduleForActiveConcurrency(unavailableCtx, {
        scheduleId: "schedule",
        expectedNextRunAt: "one",
        newNextRunAt: "two",
        concurrencyId: "concurrency",
        sessionId: "session",
      }),
    ).rejects.toThrow();
    unavailable.client.destroy();
  });
});
