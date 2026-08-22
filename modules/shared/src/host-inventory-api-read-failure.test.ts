import { afterEach, describe, expect, it } from "vitest";

import { getInventory, mutateInventory } from "./host-inventory-api.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("host inventory read failures", () => {
  it("surfaces non-404 reads instead of treating them as an empty inventory", async () => {
    globalThis.fetch = (async () =>
      new Response("inventory unavailable", { status: 500 })) as typeof fetch;

    await expect(getInventory("host-1")).rejects.toThrow("inventory unavailable");
  });

  it("aborts read-modify-write without transforming or issuing a PUT", async () => {
    let transformed = false;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("inventory unavailable", { status: 500 });
    }) as typeof fetch;

    await expect(
      mutateInventory("host-1", (inventory) => {
        transformed = true;
        return inventory;
      }),
    ).resolves.toEqual({ ok: false, error: "inventory unavailable" });
    expect(transformed).toBe(false);
    expect(calls).toBe(1);
  });
});
