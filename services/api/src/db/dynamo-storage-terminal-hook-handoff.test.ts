/* eslint-disable max-lines -- terminal handoff transaction cases share one Dynamo fixture. */
import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import { tryAcquireHostLock } from "./plane-storage-locks.ts";
import { DynamoPlaneStorageBase } from "./plane-storage-base.ts";
import { getSession, putSession } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let storage: DynamoPlaneStorageBase;
let tables: DynamoTableNames;

const base = {
  repositoryId: "repo",
  prompt: "prompt",
  target: { commandId: "command" },
  fallbacks: [],
  targetDisplayNames: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-02T00:00:00.000Z",
  timeout: 60,
  priority: 0,
  requiredLabels: [],
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const handoff = {
  handoffId: "handoff",
  hostId: "host",
  repositoryId: "repo",
  worktreeId: null,
  status: "failed" as const,
  errorCode: "host_lost" as const,
  expiresAt: "2026-01-02T00:00:00.000Z",
};

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhHandoff${process.pid}` });
  ctx = { doc: clients.doc, tables };
  storage = new DynamoPlaneStorageBase(clients.doc, tables);
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local terminal hook handoffs", () => {
  it("retains a final host-loss handoff until its current replacement connection settles it", async () => {
    await putSession(ctx, {
      ...base,
      id: "finish-handoff",
      status: "running",
      worktreeId: null,
      hostId: handoff.hostId,
      attemptId: "attempt",
      activeHostId: handoff.hostId,
      activeHostOrder: "2026-01-01T00:00:00.000Z#finish-handoff",
      terminalHookHandoffSettled: { handoffId: "old-handoff", hostId: handoff.hostId },
    });

    expect(
      await storage.finishSession({
        sessionId: "finish-handoff",
        attemptId: "attempt",
        status: "failed",
        queueShard: 0,
        errorCode: "host_lost",
        terminalHookHandoff: handoff,
      }),
    ).toBe(true);
    await expect(getSession(ctx, "finish-handoff")).resolves.toMatchObject({
      status: "failed",
      terminalHookHandoff: handoff,
      activeHostId: handoff.hostId,
    });
    expect((await getSession(ctx, "finish-handoff"))?.terminalHookHandoffSettled).toBeUndefined();

    expect(
      await tryAcquireHostLock(ctx, {
        hostId: handoff.hostId,
        connectionId: "current-connection",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await storage.settleTerminalHookHandoff({
        sessionId: "finish-handoff",
        handoffId: handoff.handoffId,
        hostId: handoff.hostId,
        connectionId: "stale-connection",
      }),
    ).toBe(false);
    expect(
      await storage.settleTerminalHookHandoff({
        sessionId: "finish-handoff",
        handoffId: handoff.handoffId,
        hostId: handoff.hostId,
        connectionId: "current-connection",
        result: { summary: "post-hook", summarySource: "harness" },
      }),
    ).toBe(true);
    await expect(getSession(ctx, "finish-handoff")).resolves.toMatchObject({
      terminalHookHandoffSettled: { handoffId: handoff.handoffId, hostId: handoff.hostId },
      result: { summary: "post-hook", summarySource: "harness" },
    });
    const settled = await getSession(ctx, "finish-handoff");
    expect(settled?.terminalHookHandoff).toBeUndefined();
    expect(settled?.activeHostId).toBeUndefined();
    expect(
      await storage.settleTerminalHookHandoff({
        sessionId: "finish-handoff",
        handoffId: handoff.handoffId,
        hostId: handoff.hostId,
        connectionId: "current-connection",
      }),
    ).toBe(true);
  });

  it("expires only the exact unclaimed handoff and preserves unexpected Dynamo failures", async () => {
    await putSession(ctx, {
      ...base,
      id: "expire-handoff",
      status: "failed",
      worktreeId: null,
      hostId: handoff.hostId,
      activeHostId: handoff.hostId,
      activeHostOrder: "2026-01-01T00:00:00.000Z#expire-handoff",
      terminalHookHandoff: handoff,
    });
    expect(
      await storage.expireTerminalHookHandoff({
        sessionId: "expire-handoff",
        handoffId: handoff.handoffId,
        expiresAt: "2026-01-03T00:00:00.000Z",
      }),
    ).toBe(false);
    expect((await getSession(ctx, "expire-handoff"))?.terminalHookHandoff).toEqual(handoff);
    expect(
      await storage.expireTerminalHookHandoff({
        sessionId: "expire-handoff",
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
      }),
    ).toBe(true);
    await expect(getSession(ctx, "expire-handoff")).resolves.toMatchObject({
      terminalHookHandoffExpiredAt: handoff.expiresAt,
    });
    const expired = await getSession(ctx, "expire-handoff");
    expect(expired?.terminalHookHandoff).toBeUndefined();
    expect(expired?.activeHostId).toBeUndefined();
    await expect(
      storage.expireTerminalHookHandoff({
        sessionId: "expire-handoff",
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
      }),
    ).resolves.toBe(false);
    await expect(
      new DynamoPlaneStorageBase(ctx.doc, {
        ...tables,
        sessions: "missing-sessions",
      }).expireTerminalHookHandoff({
        sessionId: "expire-handoff",
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
      }),
    ).rejects.toThrow();
  });

  it("releases retained main-checkout leases on settlement and unfenced expiry", async () => {
    async function seedMainCheckout(
      sessionId: string,
      hostId: string,
      connectionId: string,
      handoffId: string,
    ) {
      const repositoryId = `${sessionId}-repo`;
      const terminalHookHandoff = {
        ...handoff,
        handoffId,
        hostId,
        repositoryId,
        mainCheckoutLease: true as const,
      };
      await ctx.doc.send(
        new PutCommand({
          TableName: tables.hostLocks,
          Item: {
            hostId,
            connectionId,
            mainCheckoutLeases: {
              [repositoryId]: { sessionId, connectionId },
            },
          },
        }),
      );
      await putSession(ctx, {
        ...base,
        id: sessionId,
        repositoryId,
        status: "failed",
        worktreeId: null,
        hostId,
        attemptId: `${sessionId}-attempt`,
        assignmentConnectionId: connectionId,
        assignmentSentAt: base.createdAt,
        ackReceivedAt: base.createdAt,
        reconnectDeadlineAt: base.createdAt,
        mainCheckoutLease: true,
        activeHostId: hostId,
        activeHostOrder: `${base.createdAt}#${sessionId}`,
        terminalHookHandoff,
      });
      return { repositoryId, terminalHookHandoff };
    }

    const settled = await seedMainCheckout(
      "settled-main",
      "settled-main-host",
      "settled-main-connection",
      "settled-main-handoff",
    );
    await expect(
      storage.settleTerminalHookHandoff({
        sessionId: "settled-main",
        handoffId: settled.terminalHookHandoff.handoffId,
        hostId: settled.terminalHookHandoff.hostId,
        connectionId: "settled-main-connection",
        mainCheckoutRepositoryId: settled.repositoryId,
      }),
    ).resolves.toBe(true);
    await expect(getSession(ctx, "settled-main")).resolves.not.toHaveProperty("mainCheckoutLease");
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.hostLocks, Key: { hostId: "settled-main-host" } }),
        )
      ).Item?.mainCheckoutLeases,
    ).toEqual({});

    const expired = await seedMainCheckout(
      "expired-main",
      "expired-main-host",
      "expired-main-connection",
      "expired-main-handoff",
    );
    await expect(
      storage.expireTerminalHookHandoff({
        sessionId: "expired-main",
        handoffId: expired.terminalHookHandoff.handoffId,
        expiresAt: expired.terminalHookHandoff.expiresAt,
        hostId: expired.terminalHookHandoff.hostId,
        mainCheckoutRepositoryId: expired.repositoryId,
      }),
    ).resolves.toBe(true);
    await expect(getSession(ctx, "expired-main")).resolves.not.toHaveProperty("mainCheckoutLease");
    expect(
      (
        await ctx.doc.send(
          new GetCommand({ TableName: tables.hostLocks, Key: { hostId: "expired-main-host" } }),
        )
      ).Item?.mainCheckoutLeases,
    ).toEqual({});

    const fencedExpiry = await seedMainCheckout(
      "fenced-expired-main",
      "fenced-expired-main-host",
      "fenced-expired-main-connection",
      "fenced-expired-main-handoff",
    );
    await expect(
      storage.expireTerminalHookHandoff({
        sessionId: "fenced-expired-main",
        handoffId: fencedExpiry.terminalHookHandoff.handoffId,
        expiresAt: fencedExpiry.terminalHookHandoff.expiresAt,
        hostId: fencedExpiry.terminalHookHandoff.hostId,
        connectionId: "fenced-expired-main-connection",
        mainCheckoutRepositoryId: fencedExpiry.repositoryId,
      }),
    ).resolves.toBe(true);

    await putSession(ctx, {
      ...base,
      id: "host-fenced-expiry",
      status: "failed",
      worktreeId: null,
      hostId: "expiry-host",
      terminalHookHandoff: {
        ...handoff,
        handoffId: "host-fenced-expiry-handoff",
        hostId: "expiry-host",
      },
    });
    await expect(
      storage.expireTerminalHookHandoff({
        sessionId: "host-fenced-expiry",
        handoffId: "host-fenced-expiry-handoff",
        expiresAt: handoff.expiresAt,
        hostId: "expiry-host",
        connectionId: "missing-host-lock",
      }),
    ).resolves.toBe(false);

    await expect(
      new DynamoPlaneStorageBase(ctx.doc, {
        ...tables,
        sessions: "missing-sessions",
      }).settleTerminalHookHandoff({
        sessionId: "settled-main",
        handoffId: settled.terminalHookHandoff.handoffId,
        hostId: settled.terminalHookHandoff.hostId,
        connectionId: "settled-main-connection",
      }),
    ).rejects.toThrow();
  });
});
