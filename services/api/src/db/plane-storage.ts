import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { SessionStatus } from "@auto-harness/shared";

import { statusShardAttr, type DynamoTableNames } from "./dynamo.ts";
import type { SessionRecord, WorktreeRecord } from "./types.ts";

type ConnectionRecord = {
  connectionId: string;
  type: "agent" | "client";
  agentId: string;
  connectedAt: string;
  lastHeartbeatAt: string;
  commandProfiles: string[];
};

type ScheduleRecord = {
  id: string;
  repositoryId: string;
  name: string;
  commandProfile: string;
  cron: string;
  enabled: boolean;
  timeout: number;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  ref?: string;
};

type LogRecord = {
  sessionId: string;
  timestampSeq: string;
  stream: string;
  content: string;
  timestamp: string;
  seq: number;
};

type ArchiveObject = {
  key: string;
  body: string;
  contentType: string;
};

export type RepositoryRecord = {
  id: string;
  name: string;
  /** Git remote URL and/or local path identity for operators. */
  url: string;
  defaultBranch: string;
  setupScript?: string;
  terminalHookScript?: string;
  createdAt: string;
  updatedAt: string;
};

/**
 * DynamoDB persistence for the control plane (DynamoDB Local or AWS).
 * Conditional writes implement exclusive claim and agent register uniqueness.
 */
export class DynamoPlaneStorage {
  private readonly doc: DynamoDBDocumentClient;
  private readonly tables: DynamoTableNames;

  constructor(doc: DynamoDBDocumentClient, tables: DynamoTableNames) {
    this.doc = doc;
    this.tables = tables;
  }

  async putSession(session: SessionRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.sessions,
        Item: sessionToItem(session),
      }),
    );
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.sessions, Key: { id } }),
    );
    return res.Item ? itemToSession(res.Item) : null;
  }

  async listAllSessions(): Promise<SessionRecord[]> {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tables.sessions,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((res.Items ?? []) as Record<string, unknown>[]));
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return items.map(itemToSession);
  }

  async listSessionsByStatus(status: SessionStatus, shard: number): Promise<SessionRecord[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.sessions,
        IndexName: "statusShard-createdAt",
        KeyConditionExpression: "statusShard = :ss",
        ExpressionAttributeValues: {
          ":ss": statusShardAttr(status, shard),
        },
      }),
    );
    return (res.Items ?? []).map((i) => itemToSession(i as Record<string, unknown>));
  }

  async putWorktree(wt: WorktreeRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.worktrees,
        Item: { ...wt },
      }),
    );
  }

  async getWorktree(id: string): Promise<WorktreeRecord | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.worktrees, Key: { id } }),
    );
    return (res.Item as WorktreeRecord | undefined) ?? null;
  }

  async listAllWorktrees(): Promise<WorktreeRecord[]> {
    const items: WorktreeRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tables.worktrees,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((res.Items ?? []) as WorktreeRecord[]));
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return items;
  }

  async listWorktreesForRepo(repositoryId: string): Promise<WorktreeRecord[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.worktrees,
        IndexName: "repositoryId-id",
        KeyConditionExpression: "repositoryId = :r",
        ExpressionAttributeValues: { ":r": repositoryId },
      }),
    );
    return (res.Items ?? []) as WorktreeRecord[];
  }

  /**
   * Conditional claim (Invariant 1): idle + online → busy.
   */
  async tryClaimWorktree(opts: {
    worktreeId: string;
    sessionId: string;
    now: string;
  }): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.worktrees,
          Key: { id: opts.worktreeId },
          UpdateExpression: "SET #s = :busy, currentSessionId = :sid, lastAssignedAt = :now",
          ConditionExpression: "#s = :idle AND #o = :true",
          ExpressionAttributeNames: { "#s": "status", "#o": "online" },
          ExpressionAttributeValues: {
            ":busy": "busy",
            ":idle": "idle",
            ":true": true,
            ":sid": opts.sessionId,
            ":now": opts.now,
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

  async releaseWorktree(worktreeId: string, opts?: { forceOffline?: boolean }): Promise<void> {
    const wt = await this.getWorktree(worktreeId);
    if (!wt) {
      return;
    }
    const online = opts?.forceOffline ? false : wt.online;
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tables.worktrees,
        Key: { id: worktreeId },
        UpdateExpression: "SET #s = :idle, currentSessionId = :null, #o = :online",
        ExpressionAttributeNames: { "#s": "status", "#o": "online" },
        ExpressionAttributeValues: {
          ":idle": "idle",
          ":null": null,
          ":online": online,
        },
      }),
    );
  }

  async setWorktreeOnline(worktreeId: string, online: boolean): Promise<void> {
    await this.doc.send(
      new UpdateCommand({
        TableName: this.tables.worktrees,
        Key: { id: worktreeId },
        UpdateExpression: "SET #o = :o",
        ExpressionAttributeNames: { "#o": "online" },
        ExpressionAttributeValues: { ":o": online },
      }),
    );
  }

  /**
   * Conditional agent lock (Invariant 3).
   * Returns false if agentId already locked and replace is false.
   */
  async tryAcquireAgentLock(opts: {
    agentId: string;
    connectionId: string;
    replaceExisting: boolean;
  }): Promise<boolean> {
    if (opts.replaceExisting) {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.agentLocks,
          Item: { agentId: opts.agentId, connectionId: opts.connectionId },
        }),
      );
      return true;
    }
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.agentLocks,
          Item: { agentId: opts.agentId, connectionId: opts.connectionId },
          ConditionExpression: "attribute_not_exists(agentId)",
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

  async releaseAgentLock(agentId: string, connectionId: string): Promise<void> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tables.agentLocks,
          Key: { agentId },
          ConditionExpression: "connectionId = :c",
          ExpressionAttributeValues: { ":c": connectionId },
        }),
      );
    } catch (err) {
      if (isConditionalFailed(err)) {
        return;
      }
      throw err;
    }
  }

  async getAgentLock(agentId: string): Promise<string | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.agentLocks, Key: { agentId } }),
    );
    return (res.Item?.connectionId as string | undefined) ?? null;
  }

  async putConnection(conn: ConnectionRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.connections,
        Item: { ...conn },
      }),
    );
  }

  async getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tables.connections,
        Key: { connectionId },
      }),
    );
    return (res.Item as ConnectionRecord | undefined) ?? null;
  }

  async deleteConnection(connectionId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({
        TableName: this.tables.connections,
        Key: { connectionId },
      }),
    );
  }

  async listConnections(): Promise<ConnectionRecord[]> {
    const items: ConnectionRecord[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const res = await this.doc.send(
        new ScanCommand({
          TableName: this.tables.connections,
          ExclusiveStartKey: startKey,
        }),
      );
      items.push(...((res.Items ?? []) as ConnectionRecord[]));
      startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (startKey);
    return items;
  }

  async putLog(rec: LogRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.sessionLogs,
        Item: { ...rec },
      }),
    );
  }

  async listLogs(sessionId: string): Promise<LogRecord[]> {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.sessionLogs,
        KeyConditionExpression: "sessionId = :s",
        ExpressionAttributeValues: { ":s": sessionId },
        ScanIndexForward: true,
      }),
    );
    return (res.Items ?? []) as LogRecord[];
  }

  async putSchedule(rec: ScheduleRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.schedules,
        Item: { ...rec },
      }),
    );
  }

  async getSchedule(id: string): Promise<ScheduleRecord | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.schedules, Key: { id } }),
    );
    return (res.Item as ScheduleRecord | undefined) ?? null;
  }

  async listSchedules(): Promise<ScheduleRecord[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tables.schedules }));
    return (res.Items ?? []) as ScheduleRecord[];
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tables.schedules, Key: { id } }));
  }

  async putRepository(rec: RepositoryRecord): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.repositories,
        Item: { ...rec },
      }),
    );
  }

  async getRepository(id: string): Promise<RepositoryRecord | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.repositories, Key: { id } }),
    );
    return (res.Item as RepositoryRecord | undefined) ?? null;
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tables.repositories }));
    return (res.Items ?? []) as RepositoryRecord[];
  }

  async deleteRepository(id: string): Promise<void> {
    await this.doc.send(new DeleteCommand({ TableName: this.tables.repositories, Key: { id } }));
  }

  /**
   * Conditional nextRunAt advance (Invariant 4).
   */
  async tryClaimSchedule(
    scheduleId: string,
    expectedNextRunAt: string,
    newNextRunAt: string,
    lastRunAt: string,
  ): Promise<boolean> {
    try {
      await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.schedules,
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

  async putArchive(obj: ArchiveObject): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.archives,
        Item: { ...obj },
      }),
    );
  }

  async getArchive(key: string): Promise<ArchiveObject | null> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tables.archives, Key: { key } }),
    );
    return (res.Item as ArchiveObject | undefined) ?? null;
  }

  async listArchives(): Promise<ArchiveObject[]> {
    const res = await this.doc.send(new ScanCommand({ TableName: this.tables.archives }));
    return (res.Items ?? []) as ArchiveObject[];
  }

  /** Test helper: wipe all items in every table (DynamoDB Local). */
  async clearAll(): Promise<void> {
    for (const session of await this.listAllSessions()) {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tables.sessions, Key: { id: session.id } }),
      );
    }
    for (const wt of await this.listAllWorktrees()) {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tables.worktrees, Key: { id: wt.id } }),
      );
    }
    for (const c of await this.listConnections()) {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.tables.connections,
          Key: { connectionId: c.connectionId },
        }),
      );
    }
    // agent locks
    {
      let startKey: Record<string, unknown> | undefined;
      do {
        const res = await this.doc.send(
          new ScanCommand({
            TableName: this.tables.agentLocks,
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of res.Items ?? []) {
          await this.doc.send(
            new DeleteCommand({
              TableName: this.tables.agentLocks,
              Key: { agentId: item.agentId },
            }),
          );
        }
        startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (startKey);
    }
    for (const s of await this.listSchedules()) {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tables.schedules, Key: { id: s.id } }),
      );
    }
    for (const r of await this.listRepositories()) {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tables.repositories, Key: { id: r.id } }),
      );
    }
    for (const a of await this.listArchives()) {
      await this.doc.send(
        new DeleteCommand({ TableName: this.tables.archives, Key: { key: a.key } }),
      );
    }
    // logs: scan delete
    {
      let startKey: Record<string, unknown> | undefined;
      do {
        const res = await this.doc.send(
          new ScanCommand({
            TableName: this.tables.sessionLogs,
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of res.Items ?? []) {
          await this.doc.send(
            new DeleteCommand({
              TableName: this.tables.sessionLogs,
              Key: {
                sessionId: item.sessionId,
                timestampSeq: item.timestampSeq,
              },
            }),
          );
        }
        startKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (startKey);
    }
  }
}

function sessionToItem(session: SessionRecord): Record<string, unknown> {
  return {
    ...session,
    statusShard: statusShardAttr(session.status, session.queueShard),
  };
}

function itemToSession(item: Record<string, unknown>): SessionRecord {
  const { statusShard: _ss, ...rest } = item;
  return rest as SessionRecord;
}

function isConditionalFailed(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name: string }).name === "ConditionalCheckFailedException"
  );
}
