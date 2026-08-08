import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  isConditionalFailed,
  type HostInventoryRecord,
  type ArchiveObject,
  type LogRecord,
  type PlaneStorageCtx,
  type RepositoryRecord,
  type ScheduleRecord,
} from "./plane-storage-types.ts";

export async function putLog(ctx: PlaneStorageCtx, rec: LogRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.sessionLogs,
      Item: { ...rec },
    }),
  );
}

export async function listLogs(ctx: PlaneStorageCtx, sessionId: string): Promise<LogRecord[]> {
  const res = await ctx.doc.send(
    new QueryCommand({
      TableName: ctx.tables.sessionLogs,
      KeyConditionExpression: "sessionId = :s",
      ExpressionAttributeValues: { ":s": sessionId },
      ScanIndexForward: true,
    }),
  );
  return (res.Items ?? []) as LogRecord[];
}

export async function putSchedule(ctx: PlaneStorageCtx, rec: ScheduleRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.schedules,
      Item: { ...rec },
    }),
  );
}

export async function getSchedule(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<ScheduleRecord | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.schedules, Key: { id } }));
  return (res.Item as ScheduleRecord | undefined) ?? null;
}

export async function listSchedules(ctx: PlaneStorageCtx): Promise<ScheduleRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.schedules }));
  return (res.Items ?? []) as ScheduleRecord[];
}

export async function deleteSchedule(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.schedules, Key: { id } }));
}

export async function putRepository(ctx: PlaneStorageCtx, rec: RepositoryRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.repositories,
      Item: { ...rec },
    }),
  );
}

export async function getRepository(
  ctx: PlaneStorageCtx,
  id: string,
): Promise<RepositoryRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.repositories, Key: { id } }),
  );
  return (res.Item as RepositoryRecord | undefined) ?? null;
}

export async function listRepositories(ctx: PlaneStorageCtx): Promise<RepositoryRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.repositories }));
  return (res.Items ?? []) as RepositoryRecord[];
}

export async function deleteRepository(ctx: PlaneStorageCtx, id: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.repositories, Key: { id } }));
}

/** Conditional nextRunAt advance (Invariant 4). */
export async function tryClaimSchedule(
  ctx: PlaneStorageCtx,
  scheduleId: string,
  expectedNextRunAt: string,
  newNextRunAt: string,
  lastRunAt: string,
): Promise<boolean> {
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.schedules,
        Key: { id: scheduleId },
        UpdateExpression: "SET nextRunAt = :n, lastRunAt = :l",
        ConditionExpression: "nextRunAt = :e AND enabled = :true",
        ExpressionAttributeValues: {
          ":n": newNextRunAt,
          ":l": lastRunAt,
          ":e": expectedNextRunAt,
          ":true": true,
        },
      }),
    );
    return true;
  } catch (err) {
    if (isConditionalFailed(err)) {
      return false;
    }
    throw err;
  }
}

export async function putArchive(ctx: PlaneStorageCtx, obj: ArchiveObject): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.archives,
      Item: { ...obj },
    }),
  );
}

export async function getArchive(ctx: PlaneStorageCtx, key: string): Promise<ArchiveObject | null> {
  const res = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.archives, Key: { key } }));
  return (res.Item as ArchiveObject | undefined) ?? null;
}

export async function listArchives(ctx: PlaneStorageCtx): Promise<ArchiveObject[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.archives }));
  return (res.Items ?? []) as ArchiveObject[];
}

export async function putAgentHost(ctx: PlaneStorageCtx, rec: HostInventoryRecord): Promise<void> {
  await ctx.doc.send(
    new PutCommand({
      TableName: ctx.tables.hostInventories,
      Item: { ...rec },
    }),
  );
}

export async function getAgentHost(
  ctx: PlaneStorageCtx,
  hostId: string,
): Promise<HostInventoryRecord | null> {
  const res = await ctx.doc.send(
    new GetCommand({ TableName: ctx.tables.hostInventories, Key: { hostId } }),
  );
  return (res.Item as HostInventoryRecord | undefined) ?? null;
}

export async function listAgentHosts(ctx: PlaneStorageCtx): Promise<HostInventoryRecord[]> {
  const res = await ctx.doc.send(new ScanCommand({ TableName: ctx.tables.hostInventories }));
  return (res.Items ?? []) as HostInventoryRecord[];
}

export async function deleteAgentHost(ctx: PlaneStorageCtx, hostId: string): Promise<void> {
  await ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.hostInventories, Key: { hostId } }));
}
