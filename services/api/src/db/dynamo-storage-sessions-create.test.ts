import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, afterAll, beforeAll } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  createSession,
  getConcurrencyLock,
  getSession,
  isCreateSessionConflict,
  listAllSessions,
  listSessionsByStatus,
  putSession,
  releaseConcurrencyLock,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;
const base = {
  repositoryId: "repo",
  prompt: "prompt",
  target: { commandId: "command" },
  fallbacks: [],
  targetLabels: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T01:00:00.000Z",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35Create${process.pid}` });
  ctx = { doc: clients.doc, tables };
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local session creation", () => {
  it("persists, reads, pages, and rejects a non-concurrent id collision", async () => {
    expect(await listAllSessions(ctx)).toEqual([]);
    expect(await listSessionsByStatus(ctx, "running", 0)).toEqual([]);
    const first = { ...base, id: "plain", status: "queued" as const };
    await putSession(ctx, first);
    expect(await getSession(ctx, "plain")).toMatchObject({ id: "plain", status: "queued" });
    expect(await getSession(ctx, "missing", true)).toBeNull();
    expect((await listAllSessions(ctx)).map((session) => session.id)).toContain("plain");
    expect((await listSessionsByStatus(ctx, "queued", 0)).map((session) => session.id)).toContain(
      "plain",
    );
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        putSession(ctx, {
          ...base,
          id: `page-${index}`,
          status: "queued",
          metadata: { payload: "x".repeat(380_000) },
        }),
      ),
    );
    expect(
      (await listAllSessions(ctx)).filter((session) => session.id.startsWith("page-")).length,
    ).toBe(4);
    expect(
      (await listSessionsByStatus(ctx, "queued", 0)).filter((session) =>
        session.id.startsWith("page-"),
      ).length,
    ).toBe(4);
    await createSession(ctx, first).catch((error: unknown) =>
      expect(isCreateSessionConflict(error)).toBe(true),
    );
    await expect(
      createSession(ctx, { ...base, id: "broken", status: "queued" }),
    ).resolves.toMatchObject({ created: true });
    expect(isCreateSessionConflict(new Error("no"))).toBe(false);
    expect(isCreateSessionConflict(null)).toBe(false);
    await expect(
      createSession(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { ...base, id: "unavailable", status: "queued" },
      ),
    ).rejects.toThrow();
    await expect(
      createSession(
        { ...ctx, tables: { ...tables, sessions: "missing-sessions" } },
        { ...base, id: "unavailable-transaction", concurrencyId: "unavailable", status: "queued" },
      ),
    ).rejects.toThrow();
    await putSession(ctx, { ...base, id: "transaction-collision", status: "queued" });
    await createSession(ctx, {
      ...base,
      id: "transaction-collision",
      concurrencyId: "new-lock",
      status: "queued",
    }).catch((error: unknown) => expect(isCreateSessionConflict(error)).toBe(true));
  });

  it("returns the authoritative active concurrency owner and reclaims a terminal owner", async () => {
    const active = { ...base, id: "active", concurrencyId: "same", status: "queued" as const };
    await expect(createSession(ctx, active)).resolves.toEqual({ created: true, session: active });
    await expect(
      createSession(ctx, { ...base, id: "duplicate", concurrencyId: "same", status: "queued" }),
    ).resolves.toEqual({ created: false, session: active });
    expect(await getConcurrencyLock(ctx, "same")).toEqual({ sessionId: "active" });
    await releaseConcurrencyLock(ctx, "same", "wrong");
    expect(await getConcurrencyLock(ctx, "same")).toEqual({ sessionId: "active" });
    await releaseConcurrencyLock(ctx, "same", "active");
    expect(await getConcurrencyLock(ctx, "same")).toBeNull();
    await expect(
      releaseConcurrencyLock(
        { ...ctx, tables: { ...tables, concurrencyLocks: "missing-locks" } },
        "missing",
        "session",
      ),
    ).rejects.toThrow();
    const terminal = {
      ...base,
      id: "terminal",
      concurrencyId: "terminal-key",
      status: "failed" as const,
    };
    await expect(createSession(ctx, terminal)).resolves.toMatchObject({ created: true });
    await createSession(ctx, terminal).catch((error: unknown) =>
      expect(isCreateSessionConflict(error)).toBe(true),
    );
    await expect(
      createSession(ctx, {
        ...base,
        id: "reclaimed",
        concurrencyId: "terminal-key",
        status: "queued",
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it("does not create a session while an existing lock has no resolvable owner", async () => {
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.concurrencyLocks,
        Item: { concurrencyId: "raced", sessionId: 123 },
      }),
    );
    await expect(
      createSession(ctx, {
        ...base,
        id: "raced-session",
        concurrencyId: "raced",
        status: "queued",
      }),
    ).rejects.toThrow("could not resolve concurrency lock for raced");
  });
});
