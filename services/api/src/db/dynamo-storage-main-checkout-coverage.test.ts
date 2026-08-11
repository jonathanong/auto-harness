import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { putProviderAccount } from "./plane-storage-catalog-providers.ts";
import {
  ensureMainCheckoutLeaseMap,
  tryAssignMainCheckoutSession,
} from "./plane-storage-main-checkout.ts";
import { putConnection, tryAcquireHostLock } from "./plane-storage-locks.ts";
import { getSession, putSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import type { SessionRecord } from "./types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;
const now = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhMainCheckout${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local main-checkout assignment transactions", () => {
  it("creates the lease map only for its current host connection", async () => {
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "lease-host",
        connectionId: "lease-owner",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(await ensureMainCheckoutLeaseMap(ctx, "lease-host", "lease-owner")).toBe(true);
    expect(await ensureMainCheckoutLeaseMap(ctx, "lease-host", "lease-stale")).toBe(false);
  });

  it("assigns exactly once, preserving a resume snapshot and charging the selected account", async () => {
    const opts = {
      sessionId: "main-assignment",
      hostId: "main-host",
      repositoryId: "main-repository",
      connectionId: "main-connection",
      now,
      resolvedArgv: ["echo", "prompt"],
      resumeSpec: { argv: ["echo"], appendPrompt: true },
      resolvedRoute: {
        targetIndex: 0,
        commandId: "main-command",
        hostId: "main-host",
        worktreeId: null,
        attemptId: "main-attempt",
      },
      providerAccountId: "main-account",
      queueShard: 0,
      attemptId: "main-attempt",
    };
    const queued: SessionRecord = {
      id: opts.sessionId,
      repositoryId: opts.repositoryId,
      prompt: "prompt",
      target: { commandId: "main-command" },
      fallbacks: [],
      targetLabels: ["main-command"],
      queueTtlSeconds: 60,
      queueExpiresAt: now,
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "queued",
      queueShard: 0,
      createdAt: now,
    };
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: opts.hostId,
        connectionId: opts.connectionId,
        replaceExisting: false,
      }),
    ).toBe(true);
    await putConnection(ctx, {
      connectionId: opts.connectionId,
      type: "host",
      hostId: opts.hostId,
      connectedAt: now,
      lastHeartbeatAt: now,
      commandProfiles: [],
      capabilities: ["scheduled-main-checkout"],
      repositoryIds: [opts.repositoryId],
    });
    await putProviderAccount(ctx, {
      id: opts.providerAccountId,
      providerId: "provider",
      label: "account",
      usageLimitCooldownSeconds: 0,
      usageLimitedUntil: null,
      lastUsageLimitedAt: null,
      lastAssignedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await putSession(ctx, queued);

    expect(await tryAssignMainCheckoutSession(ctx, opts)).toBe(true);
    expect(await getSession(ctx, opts.sessionId)).toMatchObject({
      status: "running",
      worktreeId: null,
      mainCheckoutLease: true,
      resumeSpec: opts.resumeSpec,
    });
    expect(await tryAssignMainCheckoutSession(ctx, opts)).toBe(false);
  });

  it("allows a providerless assignment and rethrows non-conditional AWS failures", async () => {
    const opts = {
      sessionId: "main-providerless",
      hostId: "main-providerless-host",
      repositoryId: "main-providerless-repository",
      connectionId: "main-providerless-connection",
      now,
      resolvedArgv: ["echo", "prompt"],
      resolvedRoute: {
        targetIndex: 0,
        commandId: "main-command",
        hostId: "main-providerless-host",
        worktreeId: null,
        attemptId: "providerless-attempt",
      },
      queueShard: 0,
      attemptId: "providerless-attempt",
    };
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: opts.hostId,
        connectionId: opts.connectionId,
        replaceExisting: false,
      }),
    ).toBe(true);
    await putConnection(ctx, {
      connectionId: opts.connectionId,
      type: "host",
      hostId: opts.hostId,
      connectedAt: now,
      lastHeartbeatAt: now,
      commandProfiles: [],
      capabilities: ["scheduled-main-checkout"],
      repositoryIds: [opts.repositoryId],
    });
    await putSession(ctx, {
      id: opts.sessionId,
      repositoryId: opts.repositoryId,
      prompt: "prompt",
      target: { commandId: "main-command" },
      fallbacks: [],
      targetLabels: ["main-command"],
      queueTtlSeconds: 60,
      queueExpiresAt: now,
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "queued",
      queueShard: 0,
      createdAt: now,
    });
    expect(await tryAssignMainCheckoutSession(ctx, opts)).toBe(true);
    await expect(
      ensureMainCheckoutLeaseMap(
        { ...ctx, tables: { ...tables, hostLocks: "not-a-table" } },
        "missing",
        "missing",
      ),
    ).rejects.toThrow();
    await expect(
      tryAssignMainCheckoutSession(
        { ...ctx, tables: { ...tables, hostLocks: "not-a-table" } },
        { ...opts, sessionId: "missing" },
      ),
    ).rejects.toThrow();
  });
});
