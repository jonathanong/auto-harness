import { describe, expect, it, vi } from "vitest";

import {
  deleteGitHubIngressConfig,
  getGitHubIngressConfig,
  putGitHubIngressConfig,
} from "./plane-storage-github-ingress.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";
import { DynamoPlaneStorage } from "./plane-storage.ts";

const githubRecord = {
  id: "github-ingress" as const,
  type: "github-ingress" as const,
  encryptedSecret: "ciphertext",
  enabled: true,
  bindings: [],
  version: 1,
  createdAt: "2026-09-12T00:00:00.000Z",
  updatedAt: "2026-09-12T00:00:00.000Z",
};

function ctx(send: ReturnType<typeof vi.fn>): PlaneStorageCtx {
  return {
    doc: { send } as never,
    tables: { integrations: "Integrations" } as never,
  };
}

describe("GitHub ingress integration storage", () => {
  it("reads and compare-and-swaps the singleton record", async () => {
    const sends: unknown[] = [];
    const storage = ctx(
      vi.fn(async (command: { input?: Record<string, unknown> }) => {
        sends.push(command.input);
        if (command.input?.Key && sends.length === 1) return { Item: githubRecord };
        return {};
      }),
    );
    await expect(getGitHubIngressConfig(storage)).resolves.toEqual(githubRecord);
    await expect(putGitHubIngressConfig(storage, githubRecord, null)).resolves.toBe(true);
    await expect(putGitHubIngressConfig(storage, githubRecord, 1)).resolves.toBe(true);
    await expect(deleteGitHubIngressConfig(storage, 1)).resolves.toBe(true);
    expect(sends).toHaveLength(4);
    expect(sends[0]).toEqual(expect.objectContaining({ ConsistentRead: true }));
  });

  it("exposes the singleton operations through the storage facade", async () => {
    let reads = 0;
    const storage = new DynamoPlaneStorage(
      {
        send: vi.fn(async (command: { input?: Record<string, unknown> }) => {
          if (command.input?.Key && reads++ === 0) return { Item: githubRecord };
          return {};
        }),
      } as never,
      { integrations: "Integrations" } as never,
    );
    await expect(storage.getGitHubIngressConfig()).resolves.toEqual(githubRecord);
    await expect(storage.putGitHubIngressConfig(githubRecord, null)).resolves.toBe(true);
    await expect(storage.deleteGitHubIngressConfig(1)).resolves.toBe(true);
  });

  it("returns null for another integration type and reports conditional conflicts", async () => {
    await expect(
      getGitHubIngressConfig(ctx(vi.fn().mockResolvedValue({ Item: { type: "slack" } }))),
    ).resolves.toBeNull();
    const conflict = Object.assign(new Error("stale"), {
      name: "ConditionalCheckFailedException",
    });
    await expect(
      putGitHubIngressConfig(ctx(vi.fn().mockRejectedValue(conflict)), githubRecord, 1),
    ).resolves.toBe(false);
    await expect(
      deleteGitHubIngressConfig(ctx(vi.fn().mockRejectedValue(conflict)), 1),
    ).resolves.toBe(false);
    const failure = new Error("unavailable");
    await expect(
      putGitHubIngressConfig(ctx(vi.fn().mockRejectedValue(failure)), githubRecord, null),
    ).rejects.toBe(failure);
    await expect(
      deleteGitHubIngressConfig(ctx(vi.fn().mockRejectedValue(failure)), 1),
    ).rejects.toBe(failure);
  });

  it("fences writes with owned catalog deletion markers", async () => {
    const send = vi.fn().mockResolvedValue({});
    await expect(
      putGitHubIngressConfig(ctx(send), githubRecord, null, [
        { key: "repository:repo", owner: "owner", now: "2026-09-12T00:00:00.000Z" },
      ]),
    ).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          TransactItems: expect.arrayContaining([
            expect.objectContaining({
              ConditionCheck: expect.objectContaining({
                Key: { concurrencyId: "catalog-delete:repository:repo" },
              }),
            }),
            expect.objectContaining({ Put: expect.anything() }),
          ]),
        }),
      }),
    );
  });
});
