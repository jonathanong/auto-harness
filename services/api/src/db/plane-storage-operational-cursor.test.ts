import { describe, expect, it } from "vitest";

import {
  loadRepositoryActivityCursor,
  saveRepositoryActivityCursor,
} from "./plane-storage-operational-cursor.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("repository activity drain cursor", () => {
  it("loads only the matching drain generation and strongly reads the encoded scope", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          calls.push(command);
          return {
            Item: {
              drainRequestedAt: "generation-a",
              nextKey: { scopeKey: "repo", recordKey: "ACT#one" },
            },
          };
        },
      },
      tables: { sessionDrains: "SessionDrains" },
    } as unknown as PlaneStorageCtx;

    await expect(loadRepositoryActivityCursor(ctx, "repo#one", "generation-a")).resolves.toEqual({
      scopeKey: "repo",
      recordKey: "ACT#one",
    });
    await expect(
      loadRepositoryActivityCursor(ctx, "repo#one", "generation-b"),
    ).resolves.toBeUndefined();
    expect(calls[0]?.input).toMatchObject({
      ConsistentRead: true,
      Key: { scopeKey: "__repo#v2#repo%23one", recordKey: "DRAIN-CURSOR" },
    });
  });

  it("saves paging progress and clears it after a full sweep", async () => {
    const calls: Array<{ input: Record<string, unknown> }> = [];
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          calls.push(command);
          return {};
        },
      },
      tables: { sessionDrains: "SessionDrains" },
    } as unknown as PlaneStorageCtx;

    await saveRepositoryActivityCursor(ctx, "repo", "generation", { recordKey: "ACT#one" });
    await saveRepositoryActivityCursor(ctx, "repo", "generation");
    expect(calls[0]?.input.Item).toMatchObject({
      drainRequestedAt: "generation",
      nextKey: { recordKey: "ACT#one" },
    });
    expect(calls[1]?.input.Item).toEqual({
      scopeKey: "__repo#v2#repo",
      recordKey: "DRAIN-CURSOR",
      drainRequestedAt: "generation",
    });
  });
});
