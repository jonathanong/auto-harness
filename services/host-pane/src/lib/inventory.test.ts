import { afterEach, describe, expect, it } from "vitest";

import { setApiTransportForTests } from "./api.ts";
import { loadHostInventoryWithVersion } from "./inventory.ts";

afterEach(() => setApiTransportForTests(undefined));

describe("loadHostInventoryWithVersion", () => {
  it("returns the real version a persisted inventory was read at", async () => {
    setApiTransportForTests(async () =>
      Response.json({ repositories: [], providerAccounts: [], version: 7 }),
    );

    await expect(loadHostInventoryWithVersion("host-a")).resolves.toEqual({
      inventory: { repositories: [], providerAccounts: [] },
      version: 7,
    });
  });

  it("reads a pre-versioning record's missing version as 0", async () => {
    setApiTransportForTests(async () => Response.json({ repositories: [], providerAccounts: [] }));

    const { version } = await loadHostInventoryWithVersion("host-a");
    expect(version).toBe(0);
  });
});
