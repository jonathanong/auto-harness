import { describe, expect, it, vi } from "vitest";

import { migrateUntilReady } from "./migrate-session-drain-ledger.mts";

describe("session-drain ledger deployment migration", () => {
  it("drives resumable pages until the readiness record is durable", async () => {
    const migratePage = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(migrateUntilReady(migratePage, 4)).resolves.toBe(3);
    expect(migratePage).toHaveBeenCalledTimes(3);
  });

  it("fails closed at the bounded page-attempt limit", async () => {
    const migratePage = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    await expect(migrateUntilReady(migratePage, 2)).rejects.toThrow(
      "did not become ready after 2 bounded page attempts",
    );
    expect(migratePage).toHaveBeenCalledTimes(2);
  });
});
