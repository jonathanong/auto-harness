import { describe, expect, it } from "vitest";

import { backfillArchiveRetryIndexPage } from "./ensure-archive-retry-index.ts";

const tables = { archives: "Archives", sessionDrains: "SessionDrains" };

describe("archive retry migration", () => {
  it("rescans after readiness so a legacy writer cannot leave an unindexed row behind", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const doc = {
      send: async (command: { input: Record<string, unknown> }) => {
        calls.push(command);
        if (!command.input.UpdateExpression && command.input.TableName === "SessionDrains") {
          return { Item: { recordType: "archive-retry-v1" } };
        }
        if (command.input.UpdateExpression?.toString().includes("ADD fence")) {
          return { Attributes: { fence: 1 } };
        }
        if (command.input.TableName === "Archives" && command.input.ConsistentRead) {
          return {
            Items: [
              {
                key: "sessions/s/logs.jsonl",
                objectStored: false,
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (command.input.TableName === "Archives") return {};
        return {};
      },
    } as never;

    await expect(backfillArchiveRetryIndexPage(doc, tables)).resolves.toBe(true);

    const scans = calls.filter(
      (call) => call.input.TableName === "Archives" && call.input.ConsistentRead,
    );
    expect(scans).toHaveLength(1);
    expect(scans[0]?.input).toMatchObject({ ConsistentRead: true, Limit: 100 });
    expect(
      calls.some((call) => call.input.UpdateExpression?.toString().includes("SET retryState")),
    ).toBe(true);
  });
});
