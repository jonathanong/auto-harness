import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { getSchedule, putSchedule, updateScheduleManagement } from "./plane-storage-catalog.ts";
import { getSession, putSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `Ah69WorkspaceKey${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  if (!tables) return;
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB workspace repository index keys", () => {
  it("omits empty repository IDs for sessions and schedules while hydrating the sentinel", async () => {
    const session = {
      id: "workspace-session",
      repositoryId: "",
      workspacePoolId: "pool",
      prompt: "workspace",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "later",
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "queued" as const,
      queueShard: 0,
      createdAt: "t",
    } as never;
    await putSession(ctx, session);
    const rawSession = await ctx.doc.send(
      new GetCommand({ TableName: tables.sessions, Key: { id: session.id } }),
    );
    expect(rawSession.Item).not.toHaveProperty("repositoryId");
    expect((await getSession(ctx, session.id))?.repositoryId).toBe("");

    const schedule = {
      id: "workspace-schedule",
      repositoryId: "",
      workspacePoolId: "pool",
      name: "Workspace",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      cron: "* * * * *",
      enabled: true,
      timeout: 30,
      queueTtlSeconds: 60,
      nextRunAt: "one",
      lastRunAt: null,
      createdAt: "t",
    };
    await putSchedule(ctx, schedule);
    const rawSchedule = await ctx.doc.send(
      new GetCommand({ TableName: tables.schedules, Key: { id: schedule.id } }),
    );
    expect(rawSchedule.Item).not.toHaveProperty("repositoryId");
    expect((await getSchedule(ctx, schedule.id))?.repositoryId).toBe("");
    await updateScheduleManagement(ctx, { ...schedule, nextRunAt: "two" }, "one");
    const updated = await ctx.doc.send(
      new GetCommand({ TableName: tables.schedules, Key: { id: schedule.id } }),
    );
    expect(updated.Item).not.toHaveProperty("repositoryId");
  });
});
