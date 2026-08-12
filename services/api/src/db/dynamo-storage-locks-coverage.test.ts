import {
  ConditionalCheckFailedException,
  DeleteTableCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  conditionalHostWriteOrThrow,
  connectionPageItems,
  deleteConnection,
  getConnection,
  getHostLock,
  heartbeatConnection,
  listConnections,
  markHostDraining,
  nextConnectionPage,
  putConnection,
  releaseHostConnection,
  releaseHostLock,
  tryAcquireHostLock,
  tryRegisterHost,
} from "./plane-storage-locks.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

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
    expect(nextConnectionPage(undefined)).toBeUndefined();
    expect(nextConnectionPage({})).toBeUndefined();
    expect(nextConnectionPage({ connectionId: "next" })).toEqual({ connectionId: "next" });
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
