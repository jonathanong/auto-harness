import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

const ctx = createDynamoTestCtx("PlPr");

describe("ControlPlane providers — real DynamoDB Local write-through", () => {
  it("create/update/delete persist, and a fresh plane hydrates them back", async () => {
    if (!ctx.available || !ctx.storage) {
      expect(true).toBe(true);
      return;
    }
    const plane = new ControlPlane({ storage: ctx.storage, now: () => "t" });

    // queueWrite fires each mutation's Dynamo write without awaiting it — settleStorage
    // must run between mutations of the *same* record, or their writes can land out of
    // order (nothing in production serializes same-key writes either; each of these
    // corresponds to a separate request in practice, never fired back-to-back like this).
    plane.createProvider({ id: "p1", name: "claude" });
    plane.createCommand({ id: "c1", name: "echo", argv: ["echo"] });
    plane.createProviderAccount({ id: "a1", providerId: "p1", label: "x@y.com" });
    await plane.settleStorage();
    plane.updateProvider("p1", { name: "codex" });
    plane.updateCommand("c1", { name: "echo2" });
    plane.updateProviderAccount("a1", { label: "b@c.com" });
    await plane.settleStorage();

    const fresh = new ControlPlane({ storage: ctx.storage, now: () => "t" });
    await fresh.hydrateFromStorage();
    expect(fresh.getProvider("p1")?.name).toBe("codex");
    expect(fresh.getCommand("c1")?.name).toBe("echo2");
    expect(fresh.getProviderAccount("a1")?.label).toBe("b@c.com");

    plane.deleteCommand("c1");
    plane.deleteProviderAccount("a1");
    plane.deleteProvider("p1");
    await plane.settleStorage();

    const afterDelete = new ControlPlane({ storage: ctx.storage, now: () => "t" });
    await afterDelete.hydrateFromStorage();
    expect(afterDelete.getProvider("p1")).toBeNull();
    expect(afterDelete.getCommand("c1")).toBeNull();
    expect(afterDelete.getProviderAccount("a1")).toBeNull();
  });
});
