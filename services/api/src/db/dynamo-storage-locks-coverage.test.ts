/* eslint-disable max-lines -- real Dynamo lock, retry-candidate, and paging cases share one table fixture. */
import {
  ConditionalCheckFailedException,
  DeleteTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  clearHostOfflineAlertCandidate,
  conditionalHostWriteOrThrow,
  connectionPageItems,
  deleteConnection,
  enqueueHostOfflineAlertCandidate,
  getConnection,
  getHostLock,
  heartbeatConnection,
  listConnections,
  listHostOfflineAlertCandidates,
  markHostDraining,
  putConnection,
  releaseHostConnection,
  releaseHostLock,
  recordHostOfflineAlertCandidate,
  tryAcquireHostLock,
  tryRegisterHost,
} from "./plane-storage-locks.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { nextPageKey } from "./plane-storage-types.ts";

let client: DynamoDBClient;
let ctx: PlaneStorageCtx;
let tables: DynamoTableNames;
const at = "2026-01-01T00:00:00.000Z";
const connection = (connectionId: string, hostId: string) => ({
  connectionId,
  type: "host" as const,
  hostId,
  connectedAt: at,
  lastHeartbeatAt: at,
  commandProfiles: [],
});

function offlineDelivery(hostId: string, lastHeartbeatAt: string) {
  return {
    id: `slack:host:${hostId}:offline:${lastHeartbeatAt}`,
    integrationId: "slack" as const,
    sessionId: `host:${hostId}`,
    event: "host_offline" as const,
    operation: "post-root" as const,
    channel: "#ops",
    text: "offline",
    status: "pending" as const,
    attempts: 0,
    maxAttempts: 8,
    nextAttemptAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `Ah69Locks${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

describe("DynamoDB Local host lock adapters", () => {
  it("classifies conditional SDK responses without a DynamoDB client double", () => {
    expect(
      conditionalHostWriteOrThrow(
        new ConditionalCheckFailedException({ $metadata: {}, message: "conditional" }),
      ),
    ).toBe(false);
    expect(() => conditionalHostWriteOrThrow(new Error("unavailable"))).toThrow("unavailable");
    expect(connectionPageItems(undefined)).toEqual([]);
    expect(connectionPageItems([connection("connection", "host")])).toHaveLength(1);
    expect(nextPageKey(undefined)).toBeUndefined();
    expect(nextPageKey({})).toBeUndefined();
    expect(nextPageKey({ connectionId: "next" })).toEqual({ connectionId: "next" });
  });
  it("coordinates registration, replacement, draining, heartbeat, and release", async () => {
    expect(
      await tryRegisterHost(ctx, {
        hostId: "host",
        connection: connection("one", "host"),
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await tryRegisterHost(ctx, {
        hostId: "host",
        connection: connection("duplicate", "host"),
        replaceExisting: false,
      }),
    ).toBe(false);
    expect(await heartbeatConnection(ctx, { hostId: "host", connectionId: "one", at })).toBe(true);
    expect(await heartbeatConnection(ctx, { hostId: "host", connectionId: "wrong", at })).toBe(
      false,
    );
    expect(await markHostDraining(ctx, { hostId: "host", connectionId: "one" })).toBe(true);
    expect(await markHostDraining(ctx, { hostId: "host", connectionId: "wrong" })).toBe(false);
    expect(
      await tryRegisterHost(ctx, {
        hostId: "host",
        connection: connection("two", "host"),
        replaceExisting: true,
      }),
    ).toBe(true);
    expect(await getConnection(ctx, "one")).toBeNull();
    expect(await getHostLock(ctx, "host")).toBe("two");
    expect(await releaseHostConnection(ctx, { hostId: "host", connectionId: "wrong" })).toBe(false);
    expect(await releaseHostConnection(ctx, { hostId: "host", connectionId: "two" })).toBe(true);
    expect(await getHostLock(ctx, "host")).toBeNull();
  });

  it("enforces lock ownership and connection CRUD", async () => {
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "simple",
        connectionId: "one",
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "simple",
        connectionId: "two",
        replaceExisting: false,
      }),
    ).toBe(false);
    expect(
      await tryAcquireHostLock(ctx, {
        hostId: "simple",
        connectionId: "two",
        replaceExisting: true,
      }),
    ).toBe(true);
    await releaseHostLock(ctx, "simple", "wrong");
    expect(await getHostLock(ctx, "simple")).toBe("two");
    await releaseHostLock(ctx, "simple", "two");
    await putConnection(ctx, connection("standalone", "standalone-host"));
    expect((await getConnection(ctx, "standalone"))?.hostId).toBe("standalone-host");
    expect(await getConnection(ctx, "missing")).toBeNull();
    expect((await listConnections(ctx)).map(({ connectionId }) => connectionId)).toContain(
      "standalone",
    );
    await deleteConnection(ctx, "standalone");
    expect(await getConnection(ctx, "standalone")).toBeNull();
  });

  it("durably records and conditionally clears offline-alert candidates", async () => {
    await tryRegisterHost(ctx, {
      hostId: "alert-host",
      connection: connection("alert-connection", "alert-host"),
      replaceExisting: false,
    });
    expect(
      await releaseHostConnection(ctx, {
        hostId: "alert-host",
        connectionId: "alert-connection",
        offlineAlert: {
          reason: "agent disconnected; requeued",
          lastHeartbeatAt: at,
        },
      }),
    ).toBe(true);
    await expect(listHostOfflineAlertCandidates(ctx)).resolves.toContainEqual({
      hostId: "alert-host",
      reason: "agent disconnected; requeued",
      lastHeartbeatAt: at,
    });
    expect(
      await clearHostOfflineAlertCandidate(ctx, {
        hostId: "alert-host",
        reason: "newer candidate",
        lastHeartbeatAt: at,
      }),
    ).toBe(false);
    expect(
      await clearHostOfflineAlertCandidate(ctx, {
        hostId: "alert-host",
        reason: "agent disconnected; requeued",
        lastHeartbeatAt: at,
      }),
    ).toBe(true);
    expect(
      await recordHostOfflineAlertCandidate(ctx, {
        hostId: "alert-host",
        reason: "agent disconnected; requeued",
        lastHeartbeatAt: at,
      }),
    ).toBe(true);
    // A replacement registration is a fresh liveness signal, so it removes a
    // retry candidate that a concurrently warming cron Lambda might observe.
    expect(
      await tryRegisterHost(ctx, {
        hostId: "alert-host",
        connection: connection("alert-reconnected", "alert-host"),
        replaceExisting: false,
      }),
    ).toBe(true);
    await expect(listHostOfflineAlertCandidates(ctx)).resolves.not.toContainEqual(
      expect.objectContaining({ hostId: "alert-host" }),
    );
    expect(
      await recordHostOfflineAlertCandidate(ctx, {
        hostId: "legacy-alert-host",
        reason: "agent heartbeat stale; requeued",
        lastHeartbeatAt: at,
      }),
    ).toBe(true);
    // A partially-corrupt legacy row still satisfies the Dynamo filter, but
    // must never become an alert payload.
    await ctx.doc.send(
      new PutCommand({
        TableName: tables.hostLocks,
        Item: {
          hostId: "malformed-alert-host",
          offlineAlertReason: 1,
          offlineAlertLastHeartbeatAt: at,
        },
      }),
    );
    // A cold cron Lambda must not overwrite a newer durable observation with
    // an older warm-process retry candidate.
    expect(
      await recordHostOfflineAlertCandidate(ctx, {
        hostId: "legacy-alert-host",
        reason: "older candidate",
        lastHeartbeatAt: "2025-12-31T23:59:59.000Z",
      }),
    ).toBe(false);
    await expect(listHostOfflineAlertCandidates(ctx)).resolves.toContainEqual({
      hostId: "legacy-alert-host",
      reason: "agent heartbeat stale; requeued",
      lastHeartbeatAt: at,
    });
    await expect(listHostOfflineAlertCandidates(ctx)).resolves.not.toContainEqual(
      expect.objectContaining({ hostId: "malformed-alert-host" }),
    );
    expect(
      await clearHostOfflineAlertCandidate(ctx, {
        hostId: "legacy-alert-host",
        reason: "agent heartbeat stale; requeued",
        lastHeartbeatAt: at,
      }),
    ).toBe(true);

    const atomicCandidate = {
      hostId: "atomic-alert-host",
      reason: "agent heartbeat stale; requeued",
      lastHeartbeatAt: at,
    };
    expect(await recordHostOfflineAlertCandidate(ctx, atomicCandidate)).toBe(true);
    const atomicDelivery = offlineDelivery(atomicCandidate.hostId, atomicCandidate.lastHeartbeatAt);
    expect(await enqueueHostOfflineAlertCandidate(ctx, atomicCandidate, atomicDelivery)).toBe(true);
    await expect(listHostOfflineAlertCandidates(ctx)).resolves.not.toContainEqual(atomicCandidate);
    await expect(
      client.send(
        new GetCommand({
          TableName: tables.notificationDeliveries,
          Key: { id: atomicDelivery.id },
        }),
      ),
    ).resolves.toMatchObject({ Item: expect.objectContaining({ id: atomicDelivery.id }) });

    const reconnectedCandidate = { ...atomicCandidate, hostId: "reconnected-alert-host" };
    expect(await recordHostOfflineAlertCandidate(ctx, reconnectedCandidate)).toBe(true);
    expect(
      await tryRegisterHost(ctx, {
        hostId: reconnectedCandidate.hostId,
        connection: connection("reconnected-alert", reconnectedCandidate.hostId),
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await enqueueHostOfflineAlertCandidate(
        ctx,
        reconnectedCandidate,
        offlineDelivery(reconnectedCandidate.hostId, reconnectedCandidate.lastHeartbeatAt),
      ),
    ).toBe(false);
  });

  it("continues a real DynamoDB scan past its one-megabyte page boundary", async () => {
    const payload = "x".repeat(300_000);
    await Promise.all(
      ["page-one", "page-two", "page-three", "page-four"].map((connectionId) =>
        putConnection(ctx, {
          ...connection(connectionId, "paged-host"),
          commandProfiles: [payload],
        }),
      ),
    );
    await expect(listConnections(ctx)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ connectionId: "page-one" })]),
    );
  });

  it("propagates failures from a real unreachable DynamoDB endpoint", async () => {
    const unavailable = createDynamoClients({ endpoint: "http://127.0.0.1:7468" });
    const unavailableCtx = { doc: unavailable.doc, tables };
    await expect(
      tryAcquireHostLock(unavailableCtx, {
        hostId: "host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).rejects.toThrow();
    await expect(
      tryRegisterHost(unavailableCtx, {
        hostId: "host",
        connection: connection("connection", "host"),
        replaceExisting: false,
      }),
    ).rejects.toThrow();
    await expect(
      releaseHostConnection(unavailableCtx, { hostId: "host", connectionId: "connection" }),
    ).rejects.toThrow();
    await expect(
      heartbeatConnection(unavailableCtx, { hostId: "host", connectionId: "connection", at }),
    ).rejects.toThrow();
    await expect(
      markHostDraining(unavailableCtx, { hostId: "host", connectionId: "connection" }),
    ).rejects.toThrow();
    await expect(releaseHostLock(unavailableCtx, "host", "connection")).rejects.toThrow();
    unavailable.client.destroy();
  });
});
