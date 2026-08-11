import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

const ctx = createDynamoTestCtx("PlPr");

describe("ControlPlane providers — real DynamoDB Local write-through", () => {
  it("orders dependent catalog writes through one settle and persists a restart-consistent result", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({ storage: ctx.storage, now: () => "t" });

    plane.createProvider({ id: "p1", name: "claude" });
    await plane.settleStorage();
    plane.createCommand({ id: "c1", name: "echo", argv: ["echo"] });
    plane.createProviderAccount({ id: "a1", providerId: "p1", label: "x@y.com" });
    plane.updateProvider("p1", { name: "codex" });
    plane.updateCommand("c1", { name: "echo2" });
    plane.updateProviderAccount("a1", { label: "b@c.com" });
    plane.deleteCommand("c1");
    plane.deleteProviderAccount("a1");
    expect(plane.deleteProvider("p1").ok).toBe(true);
    await plane.settleStorage();

    const afterDelete = new ControlPlane({ storage: ctx.storage, now: () => "t" });
    await afterDelete.hydrateFromStorage();
    expect(afterDelete.getProvider("p1")).toBeNull();
    expect(afterDelete.getCommand("c1")).toBeNull();
    expect(afterDelete.getProviderAccount("a1")).toBeNull();
  });

  it("continues after a failed queued write and persists later writes across restart", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const putProvider = ctx.storage.putProvider.bind(ctx.storage);
    const failing = Object.create(ctx.storage) as typeof ctx.storage;
    failing.putProvider = async (record) => {
      if (record.id === "failed-provider") {
        throw new Error("injected provider write failure");
      }
      await putProvider(record);
    };
    const plane = new ControlPlane({ storage: failing, now: () => "t" });

    plane.createProvider({ id: "failed-provider", name: "will-not-persist" });
    plane.createProvider({ id: "later-provider", name: "does-persist" });
    await expect(plane.settleStorage()).rejects.toThrow("injected provider write failure");

    const restarted = new ControlPlane({ storage: ctx.storage, now: () => "t" });
    await restarted.hydrateFromStorage();
    expect(restarted.getProvider("failed-provider")).toBeNull();
    expect(restarted.getProvider("later-provider")?.name).toBe("does-persist");
    await expect(plane.settleStorage()).resolves.toBeUndefined();
  });
});
