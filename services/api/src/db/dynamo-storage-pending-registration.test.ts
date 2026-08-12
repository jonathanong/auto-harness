import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./dynamo-test-helpers.ts";

const ctx = createDynamoTestCtx("PendingReg");
const at = "2026-01-01T00:00:00.000Z";
const connection = (connectionId: string, hostId: string) => ({
  connectionId,
  type: "host" as const,
  hostId,
  connectedAt: at,
  lastHeartbeatAt: at,
  commandProfiles: [],
});

describe("DynamoDB pending host registration", () => {
  it("atomically promotes only the matching authenticated pending connection", async () => {
    const storage = ctx.storage!;
    await storage.putConnection({ ...connection("pending", "pending-host"), registered: false });
    expect(
      await storage.tryRegisterHost({
        hostId: "pending-host",
        connection: connection("pending", "pending-host"),
        replaceExisting: false,
        consumePendingConnection: true,
      }),
    ).toBe(true);
    expect((await storage.getConnection("pending"))?.registered).toBeUndefined();
    expect(await storage.getHostLock("pending-host")).toBe("pending");

    await storage.putConnection({
      ...connection("foreign-pending", "original-host"),
      registered: false,
    });
    expect(
      await storage.tryRegisterHost({
        hostId: "attacker-host",
        connection: connection("foreign-pending", "attacker-host"),
        replaceExisting: false,
        consumePendingConnection: true,
      }),
    ).toBe(false);
    expect(await storage.getConnection("foreign-pending")).toMatchObject({
      hostId: "original-host",
      registered: false,
    });
    expect(await storage.getHostLock("attacker-host")).toBeNull();
  });
});
