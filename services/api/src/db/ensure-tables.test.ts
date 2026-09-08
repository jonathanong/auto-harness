import { describe, expect, it } from "vitest";

import { completeLocalSessionListMigration } from "./ensure-tables.ts";

describe("completeLocalSessionListMigration", () => {
  it("fails after its bounded retry budget when a concurrent migration never becomes ready", async () => {
    let migrationCalls = 0;
    const migratePage = async () => {
      migrationCalls += 1;
      return false;
    };
    await expect(
      completeLocalSessionListMigration(
        {} as never,
        { sessions: "Sessions", sessionDrains: "SessionDrains" },
        1,
        migratePage,
      ),
    ).rejects.toThrow(
      "local session-list migration did not become ready after 1 bounded page attempts",
    );
    expect(migrationCalls).toBe(1);
  });
});
