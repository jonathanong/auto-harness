import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  deleteLog,
  deleteSchedule,
  listArchives,
  listHostInventories,
  getSchedule,
  listLogs,
  listSchedules,
  listRepositories,
  putLog,
  putLogFenced,
  putSchedule,
  skipScheduleForActiveConcurrency,
  tryClaimSchedule,
  tryClaimScheduleAndCreateSession,
} from "./plane-storage-catalog.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let ctx: PlaneStorageCtx;
let client: DynamoDBClient;
let tables: DynamoTableNames;
const at = "2026-01-01T00:00:00.000Z";
const next = "2026-01-01T00:01:00.000Z";

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhLogSch${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

function schedule(id: string) {
  return {
    id,
    repositoryId: "repo",
    name: id,
    target: { commandId: "command" },
    fallbacks: [],
    targetLabels: ["command"],
    queueTtlSeconds: 60,
    cron: "* * * * *",
    enabled: true,
    timeout: 60,
    nextRunAt: at,
    lastRunAt: null,
    createdAt: at,
    ref: "main",
  };
}

function session(id: string, concurrencyId?: string) {
  return {
    id,
    repositoryId: "repo",
    prompt: "scheduled",
    target: { commandId: "command" },
    fallbacks: [],
    targetLabels: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-02T00:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    onConflict: "queue" as const,
    status: "queued" as const,
    queueShard: 0,
    createdAt: at,
    ref: "main",
    ...(concurrencyId ? { concurrencyId } : {}),
  };
}

describe("DynamoDB Local logs and schedules", () => {
  it("persists logs and rejects stale fenced writes", async () => {
    const log = {
      sessionId: "log-session",
      timestampSeq: `${at}#0000000001`,
      stream: "stdout" as const,
      content: "first",
      timestamp: at,
      seq: 1,
    };
    await putLog(ctx, log);
    expect((await listLogs(ctx, log.sessionId)).map((item) => item.content)).toEqual(["first"]);
    await deleteLog(ctx, log.sessionId, log.timestampSeq);
    expect(await listLogs(ctx, log.sessionId)).toEqual([]);

    await tryAcquireHostLock(ctx, {
      hostId: "fenced-host",
      connectionId: "live-connection",
      replaceExisting: false,
    });
    expect(
      await putLogFenced(
        ctx,
        { ...log, timestampSeq: `${at}#0000000002` },
        {
          hostId: "fenced-host",
          connectionId: "live-connection",
        },
      ),
    ).toBe(true);
    expect(
      await putLogFenced(
        ctx,
        { ...log, timestampSeq: `${at}#0000000003` },
        {
          hostId: "fenced-host",
          connectionId: "stale-connection",
        },
      ),
    ).toBe(false);
  });

  it("atomically creates, deduplicates, loses, claims, and skips schedules", async () => {
    await putSchedule(ctx, schedule("created"));
    expect(
      await tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "created",
        expectedNextRunAt: at,
        newNextRunAt: next,
        lastRunAt: at,
        session: session("created-session", "shared-lock"),
      }),
    ).toEqual({ kind: "created" });

    await putSchedule(ctx, schedule("duplicate"));
    expect(
      await tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "duplicate",
        expectedNextRunAt: at,
        newNextRunAt: next,
        lastRunAt: at,
        session: session("duplicate-session", "shared-lock"),
      }),
    ).toMatchObject({ kind: "duplicate", session: { id: "created-session" } });
    await putSchedule(ctx, schedule("lost"));
    expect(
      await tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "lost",
        expectedNextRunAt: "stale",
        newNextRunAt: next,
        lastRunAt: at,
        session: session("lost-session"),
      }),
    ).toEqual({ kind: "lost" });

    await putSchedule(ctx, schedule("claimed"));
    expect(await tryClaimSchedule(ctx, "claimed", at, next, at)).toBe(true);
    expect(await tryClaimSchedule(ctx, "claimed", at, next, at)).toBe(false);
    await putSchedule(ctx, schedule("skipped"));
    expect(
      await skipScheduleForActiveConcurrency(ctx, {
        scheduleId: "skipped",
        expectedNextRunAt: at,
        newNextRunAt: next,
        concurrencyId: "shared-lock",
        sessionId: "created-session",
      }),
    ).toBe(true);
    expect(
      await skipScheduleForActiveConcurrency(ctx, {
        scheduleId: "skipped",
        expectedNextRunAt: at,
        newNextRunAt: next,
        concurrencyId: "shared-lock",
        sessionId: "created-session",
      }),
    ).toBe(false);
    await deleteSchedule(ctx, "skipped");
    expect(await getSchedule(ctx, "skipped")).toBeNull();
    expect((await listSchedules(ctx)).length).toBeGreaterThan(0);
  });

  it("normalizes absent DynamoDB list items to empty arrays", async () => {
    const empty = { doc: { send: async () => ({}) }, tables: {} } as unknown as PlaneStorageCtx;
    await expect(listLogs(empty, "session")).resolves.toEqual([]);
    await expect(listSchedules(empty)).resolves.toEqual([]);
    await expect(listRepositories(empty)).resolves.toEqual([]);
    await expect(listArchives(empty)).resolves.toEqual([]);
    await expect(listHostInventories(empty)).resolves.toEqual([]);
  });
});
