import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  clearResumePin,
  getSession,
  putSession,
  putWorktree,
  tryAssignSession,
} from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const PROMPT = "Fix the flaky test.\nThen open a PR.";

let client: DynamoDBClient;
let tables: DynamoTableNames;
let ctx: PlaneStorageCtx;
const session = {
  repositoryId: "repo",
  prompt: PROMPT,
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T01:00:00.000Z",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  status: "queued" as const,
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhArgvStore${process.pid}` });
  ctx = { doc: clients.doc, tables };
  await ctx.doc.send(
    new PutCommand({
      TableName: tables.repositories,
      Item: { id: "repo", name: "repo", url: "url", defaultBranch: "main" },
    }),
  );
});
afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

async function rawSession(id: string): Promise<Record<string, unknown> | undefined> {
  const result = await ctx.doc.send(
    new GetCommand({ TableName: tables.sessions, Key: { id }, ConsistentRead: true }),
  );
  return result.Item;
}

function assign(prompt: string) {
  return tryAssignSession(ctx, {
    sessionId: "argv",
    repositoryId: "repo",
    worktreeId: "argv-worktree",
    hostId: "host",
    hostInventoryVersion: null,
    connectionId: "one",
    now: "2025-01-01T00:00:00.000Z",
    attemptId: "attempt",
    resolvedArgv: ["claude", "-p", PROMPT],
    prompt,
    resolvedRoute: { targetIndex: 0, commandId: "command", hostId: "host", attemptId: "attempt" },
    queueShard: 0,
  });
}

describe("DynamoDB Local stored session argv", () => {
  it("stores the prompt once and only against the row's current prompt", async () => {
    await putSession(ctx, { ...session, id: "argv" });
    await putWorktree(ctx, {
      id: "argv-worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo",
      labels: [],
      status: "idle",
      online: true,
    });
    expect(await assign("a prompt replaced since it was read")).toBe(false);
    expect(await assign(PROMPT)).toBe(true);
    expect((await rawSession("argv"))?.resolvedArgv).toEqual([
      "claude",
      "-p",
      { before: "", after: "" },
    ]);
    expect((await getSession(ctx, "argv"))?.resolvedArgv).toEqual(["claude", "-p", PROMPT]);
  });

  it("drops resolvedArgv when a resume fallback rewrites the prompt", async () => {
    await putSession(ctx, {
      ...session,
      id: "fallback",
      pinnedHostId: "host",
      resolvedArgv: ["claude", "-p", PROMPT],
    });
    expect(
      await clearResumePin(ctx, {
        sessionId: "fallback",
        pinnedHostId: "host",
        prompt: `${PROMPT}\n\nprior context`,
      }),
    ).toBe(true);
    const raw = await rawSession("fallback");
    expect(raw?.prompt).toBe(`${PROMPT}\n\nprior context`);
    expect(raw).not.toHaveProperty("resolvedArgv");
  });
});
