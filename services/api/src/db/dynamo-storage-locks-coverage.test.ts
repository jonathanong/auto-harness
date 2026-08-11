import { DeleteTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDynamoClients, type DynamoTableNames } from "./dynamo.ts";
import { ensureControlPlaneTables } from "./ensure-tables.ts";
import {
  deleteConnection,
  getConnection,
  getHostLock,
  heartbeatConnection,
  listConnections,
  markHostDraining,
  putConnection,
  releaseHostConnection,
  releaseHostLock,
  tryAcquireHostLock,
  tryRegisterHost,
} from "./plane-storage-locks.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

let ctx: PlaneStorageCtx;
let client: DynamoDBClient;
let tables: DynamoTableNames;
const at = "2026-01-01T00:00:00.000Z";

beforeAll(async () => {
  const clients = createDynamoClients();
  client = clients.client;
  tables = await ensureControlPlaneTables({ client, prefix: `AhLocks${process.pid}` });
  ctx = { doc: clients.doc, tables };
});

afterAll(async () => {
  await Promise.all(
    Object.values(tables).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
});

function connection(connectionId: string, hostId: string) {
  return {
    connectionId,
    type: "host" as const,
    hostId,
    connectedAt: at,
    lastHeartbeatAt: at,
    commandProfiles: [],
  };
}

describe("DynamoDB Local host locks and connections", () => {
  it("atomically registers, replaces, drains, heartbeats, and disconnects a host", async () => {
    expect(
      await tryRegisterHost(ctx, {
        hostId: "registered-host",
        connection: connection("registered-1", "registered-host"),
        replaceExisting: false,
      }),
    ).toBe(true);
    expect(
      await tryRegisterHost(ctx, {
        hostId: "registered-host",
        connection: connection("registered-duplicate", "registered-host"),
        replaceExisting: false,
      }),
    ).toBe(false);
    expect(
      await heartbeatConnection(ctx, {
        hostId: "registered-host",
        connectionId: "registered-1",
        at,
      }),
    ).toBe(true);
    expect(
      await heartbeatConnection(ctx, { hostId: "registered-host", connectionId: "wrong", at }),
    ).toBe(false);
    expect(
      await markHostDraining(ctx, { hostId: "registered-host", connectionId: "registered-1" }),
    ).toBe(true);
    expect(await markHostDraining(ctx, { hostId: "registered-host", connectionId: "wrong" })).toBe(
      false,
    );
    expect(
      await tryRegisterHost(ctx, {
        hostId: "registered-host",
        connection: connection("registered-2", "registered-host"),
        replaceExisting: true,
      }),
    ).toBe(true);
    expect(await getConnection(ctx, "registered-1")).toBeNull();
    expect(await getHostLock(ctx, "registered-host")).toBe("registered-2");
    expect(
      await releaseHostConnection(ctx, { hostId: "registered-host", connectionId: "wrong" }),
    ).toBe(false);
    expect(
      await releaseHostConnection(ctx, { hostId: "registered-host", connectionId: "registered-2" }),
    ).toBe(true);
    expect(await getHostLock(ctx, "registered-host")).toBeNull();
    expect(
      await tryRegisterHost(ctx, {
        hostId: "fresh-forced-host",
        connection: connection("fresh-forced", "fresh-forced-host"),
        replaceExisting: true,
      }),
    ).toBe(true);
  });

  it("enforces simple lock ownership and connection CRUD", async () => {
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
    expect(await getHostLock(ctx, "simple")).toBeNull();

    await putConnection(ctx, connection("standalone", "standalone-host"));
    expect((await getConnection(ctx, "standalone"))?.hostId).toBe("standalone-host");
    expect(await getConnection(ctx, "missing")).toBeNull();
    expect((await listConnections(ctx)).map((item) => item.connectionId)).toContain("standalone");
    await deleteConnection(ctx, "standalone");
    expect(await getConnection(ctx, "standalone")).toBeNull();
  });

  it("rethrows unavailable DynamoDB errors instead of reporting lease loss", async () => {
    const unavailable = {
      doc: { send: async () => Promise.reject(new Error("unavailable")) },
      tables: {},
    } as unknown as PlaneStorageCtx;
    await expect(
      tryAcquireHostLock(unavailable, {
        hostId: "host",
        connectionId: "connection",
        replaceExisting: false,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      tryRegisterHost(unavailable, {
        hostId: "host",
        connection: connection("connection", "host"),
        replaceExisting: false,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      releaseHostConnection(unavailable, { hostId: "host", connectionId: "connection" }),
    ).rejects.toThrow("unavailable");
    await expect(
      heartbeatConnection(unavailable, { hostId: "host", connectionId: "connection", at }),
    ).rejects.toThrow("unavailable");
    await expect(
      markHostDraining(unavailable, { hostId: "host", connectionId: "connection" }),
    ).rejects.toThrow("unavailable");
    await expect(releaseHostLock(unavailable, "host", "connection")).rejects.toThrow("unavailable");
  });

  it("continues a paginated connection scan", async () => {
    let calls = 0;
    const paged = {
      tables: {},
      doc: {
        send: async () =>
          ++calls === 1
            ? { Items: [{ connectionId: "first" }], LastEvaluatedKey: { connectionId: "first" } }
            : {},
      },
    } as unknown as PlaneStorageCtx;
    await expect(listConnections(paged)).resolves.toEqual([{ connectionId: "first" }]);
    expect(calls).toBe(2);
  });
});
