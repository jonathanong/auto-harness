/* eslint-disable max-lines -- one DynamoDB Local table backs the backfill and list cases. */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ControlPlane } from "../control-plane.ts";
import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { migrateSessionListIndexesPage } from "./ensure-session-list-backfill.ts";
import {
  ensureSessionListIndexes,
  sessionListIndexesActive,
} from "./ensure-session-list-indexes.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";
import { sessionToItem } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let storage: DynamoPlaneStorage;
let doc: ReturnType<typeof createDynamoClients>["doc"];

function session(id: string, minute: number, extra: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    repositoryId: "repo-a",
    prompt: "list indexes",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: minute % 3,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, minute)).toISOString(),
    source: "api",
    type: "prompt",
    ...extra,
  };
}

const order = (ids: string[], sort: "latest" | "oldest") =>
  sort === "latest" ? ids.toReversed() : ids;

function route(worktreeId: string | null): SessionRecord["resolvedRoute"] {
  return { targetIndex: 0, commandId: "command", hostId: "host", worktreeId, attemptId: "att" };
}

/** A row exactly as written before this change: no `sessionList` / `routeWorktreeId`. */
async function putLegacy(record: SessionRecord, extra: Record<string, unknown> = {}) {
  const { sessionList: _list, routeWorktreeId: _route, ...item } = sessionToItem(record);
  await doc.send(new PutCommand({ TableName: tables.sessions, Item: { ...item, ...extra } }));
}

async function rawItem(id: string) {
  const got = await doc.send(
    new GetCommand({ TableName: tables.sessions, Key: { id }, ConsistentRead: true }),
  );
  return got.Item as Record<string, unknown>;
}

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  doc = clients.doc;
  tables = await ensureControlPlaneTables({ client, prefix: `AhListIdx${process.pid}` });
  storage = new DynamoPlaneStorage(doc, tables);
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local unsharded session list indexes", () => {
  it("creates the three indexes, idempotently, and publishes readiness locally", async () => {
    await expect(sessionListIndexesActive(client, tables.sessions)).resolves.toBe(true);
    await ensureSessionListIndexes(client, tables.sessions);
    await ensureSessionListIndexes(client, `${tables.sessions}-missing`);
    const ready = await doc.send(
      new GetCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: "__session-list-indexes__", recordKey: "READY-V1" },
      }),
    );
    expect(ready.Item?.recordType).toBe("session-list-indexes-v1");
  });

  it("backfills legacy rows resumably and idempotently, then publishes readiness", async () => {
    await storage.clearAll();
    const legacy = Array.from({ length: 120 }, (_, index) =>
      session(`bf-${String(index).padStart(3, "0")}`, index, {
        resolvedRoute: index % 4 === 0 ? route("wt-1") : index % 4 === 1 ? route(null) : undefined,
      }),
    );
    await Promise.all(legacy.map((record) => putLegacy(record)));
    // Wrong stale value on a route-less row: the backfill must remove it.
    await putLegacy(session("bf-stale", 130), { routeWorktreeId: "wt-stale" });
    // Already complete: untouched.
    await doc.send(
      new PutCommand({
        TableName: tables.sessions,
        Item: sessionToItem(session("bf-done", 131, { resolvedRoute: route("wt-2") })),
      }),
    );

    expect(await migrateSessionListIndexesPage(doc, tables)).toBe(false);
    const checkpoint = await doc.send(
      new GetCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: "__session-list-indexes__", recordKey: "MIGRATION-V1" },
      }),
    );
    expect(checkpoint.Item?.nextKey).toBeDefined();
    expect(checkpoint.Item).not.toHaveProperty("leaseOwner");
    let pages = 1;
    while (!(await migrateSessionListIndexesPage(doc, tables))) {
      pages += 1;
      expect(pages).toBeLessThan(10);
    }

    expect(await rawItem("bf-000")).toMatchObject({ sessionList: "all", routeWorktreeId: "wt-1" });
    expect(await rawItem("bf-001")).toMatchObject({ sessionList: "all" });
    expect(await rawItem("bf-001")).not.toHaveProperty("routeWorktreeId");
    expect(await rawItem("bf-002")).not.toHaveProperty("routeWorktreeId");
    expect(await rawItem("bf-stale")).not.toHaveProperty("routeWorktreeId");
    expect(await rawItem("bf-done")).toMatchObject({ sessionList: "all", routeWorktreeId: "wt-2" });
    // Published: further calls are no-ops.
    expect(await migrateSessionListIndexesPage(doc, tables)).toBe(true);
  });

  it("yields to another holder of the backfill lease", async () => {
    await doc.send(
      new DeleteCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: "__session-list-indexes__", recordKey: "READY-V1" },
      }),
    );
    await doc.send(
      new UpdateCommand({
        TableName: tables.sessionDrains,
        Key: { scopeKey: "__session-list-indexes__", recordKey: "MIGRATION-V1" },
        UpdateExpression: "SET leaseOwner = :owner, leaseUntil = :until",
        ExpressionAttributeValues: { ":owner": "other", ":until": "2999-01-01T00:00:00.000Z" },
      }),
    );
    expect(await migrateSessionListIndexesPage(doc, tables)).toBe(false);
  });

  it("serves repository, worktree and global lists from the indexes in the memory order", async () => {
    await storage.clearAll();
    const rows = Array.from({ length: 30 }, (_, index) =>
      session(`l-${String(index).padStart(2, "0")}`, index, {
        repositoryId: index % 3 === 0 ? "repo-b" : "repo-a",
        status: index % 5 === 0 ? "queued" : "completed",
        ...(index % 4 === 0
          ? { resolvedRoute: route("wt-1"), worktreeId: index % 8 === 0 ? "wt-1" : null }
          : {}),
      }),
    );
    for (const record of rows) await storage.putSession(record);
    while (!(await migrateSessionListIndexesPage(doc, tables))) {
      // resume until the marker is published
    }
    const plane = new ControlPlane({
      storage,
      shardCount: 3,
      sessionCursorSecret: "list-index-test",
    });
    const idsFor = async (
      filter: { repositoryId?: string; worktreeId?: string },
      sort: "latest" | "oldest",
      limit: number,
    ) => {
      const ids: string[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 40; pages += 1) {
        const page = await plane.listSessionsPageDurable({
          sort,
          limit,
          ...filter,
          ...(cursor ? { cursor } : {}),
        });
        ids.push(...page.items.map((item) => item.id));
        if (!page.nextCursor) return ids;
        cursor = page.nextCursor;
      }
      throw new Error("pagination did not terminate");
    };
    const all = rows.map((row) => row.id);
    for (const sort of ["latest", "oldest"] as const) {
      expect(await idsFor({}, sort, 7)).toEqual(order(all, sort));
      expect(await idsFor({ repositoryId: "repo-b" }, sort, 4)).toEqual(
        order(
          rows.filter((row) => row.repositoryId === "repo-b").map((row) => row.id),
          sort,
        ),
      );
      // Routed to the worktree, including those later disconnected (worktreeId null).
      expect(await idsFor({ worktreeId: "wt-1" }, sort, 3)).toEqual(
        order(
          rows.filter((row) => row.resolvedRoute?.worktreeId === "wt-1").map((row) => row.id),
          sort,
        ),
      );
    }
    const storageOnly = await storage.listSessionsPage({
      limit: 100,
      sort: "latest",
      shardCount: 3,
      status: null,
      repositoryId: null,
      repositoryIds: null,
      hostId: null,
      source: null,
      concurrencyId: null,
      scheduleId: null,
    });
    expect(storageOnly.items).toHaveLength(30);
    expect(storageOnly.continuation).toBeNull();
  });
});
