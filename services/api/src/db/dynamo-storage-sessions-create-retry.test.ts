import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { createSession, putSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let doc: DynamoDBDocumentClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  doc = clients.doc;
  tables = await ensureControlPlaneTables({ client, prefix: `AhD35CreateRetry${process.pid}` });
  ctx = { doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local session creation retries", () => {
  it("exhausts retries after repeatedly deleting a terminal owner's lock", async () => {
    const concurrencyId = "terminal-owner";
    const terminalSessionId = "terminal";
    await putSession(ctx, {
      id: terminalSessionId,
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
      concurrencyId,
      status: "failed",
    });

    const replacement = createDynamoClients().doc;
    let replacedLocks = 0;
    const middlewareName = "replaceTerminalConcurrencyLock";
    doc.middlewareStack.add(
      (next, context) => async (args) => {
        const result = await next(args);
        if (
          context.commandName === "DeleteCommand" ||
          context.commandName === "DeleteItemCommand"
        ) {
          await replacement.send(
            new PutCommand({
              TableName: tables.concurrencyLocks,
              Item: { concurrencyId, sessionId: terminalSessionId },
            }),
          );
          replacedLocks += 1;
        }
        return result;
      },
      { name: middlewareName, step: "initialize" },
    );

    await doc.send(
      new PutCommand({
        TableName: tables.concurrencyLocks,
        Item: { concurrencyId, sessionId: terminalSessionId },
      }),
    );
    try {
      await expect(
        createSession(ctx, {
          id: "candidate",
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
          concurrencyId,
          status: "queued",
        }),
      ).rejects.toThrow(`could not resolve concurrency lock for ${concurrencyId}`);
      expect(replacedLocks).toBe(3);
    } finally {
      doc.middlewareStack.remove(middlewareName);
    }
  });
});
