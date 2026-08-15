import { describe, expect, it } from "vitest";

import { countSessionsByRepository, listSessionsByRepository } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("DynamoDB repository session pagination", () => {
  it("counts repository sessions through the index without materializing rows", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          commands.push(command);
          return commands.length === 1
            ? { Count: 2, LastEvaluatedKey: { id: "session-2" } }
            : { Count: 1 };
        },
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(countSessionsByRepository(ctx, "repo-1", "host-1")).resolves.toBe(3);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.input).toMatchObject({
      IndexName: "repositoryId-createdAt",
      Select: "COUNT",
      FilterExpression: "hostId = :hostId",
      ExpressionAttributeValues: { ":repositoryId": "repo-1", ":hostId": "host-1" },
    });
  });

  it("falls back to filtering the compatibility scan when counting", async () => {
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          if (command.input.IndexName) {
            const error = new Error("index is still being created");
            error.name = "ValidationException";
            throw error;
          }
          return {
            Items: [
              { id: "one", repositoryId: "repo-1", hostId: "host-1", createdAt: "t" },
              { id: "two", repositoryId: "repo-1", hostId: "host-2", createdAt: "t" },
            ],
          };
        },
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(countSessionsByRepository(ctx, "repo-1", "host-1")).resolves.toBe(1);
    await expect(countSessionsByRepository(ctx, "repo-1")).resolves.toBe(2);
  });

  it("normalizes empty count results and propagates unrelated count failures", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const empty = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          commands.push(command);
          return { LastEvaluatedKey: {} };
        },
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(countSessionsByRepository(empty, "repo-1")).resolves.toBe(0);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.input).not.toHaveProperty("FilterExpression");
    expect(commands[0]?.input).toMatchObject({
      ExpressionAttributeValues: { ":repositoryId": "repo-1" },
    });

    const failed = {
      doc: {
        send: async () => {
          throw new Error("query unavailable");
        },
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(countSessionsByRepository(failed, "repo-1")).rejects.toThrow("query unavailable");
  });

  it("reads through the repository-createdAt index", async () => {
    const commands: Array<{ input: Record<string, unknown> }> = [];
    const send = async (command: { input: Record<string, unknown> }) => {
      commands.push(command);
      return commands.length === 1
        ? {
            Items: [{ id: "session-1", repositoryId: "repo-1", createdAt: "2026-01-01" }],
            LastEvaluatedKey: { id: "session-1" },
          }
        : { Items: [{ id: "session-2", repositoryId: "repo-1", createdAt: "2026-01-02" }] };
    };
    const ctx = {
      doc: { send },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionsByRepository(ctx, "repo-1")).resolves.toMatchObject([
      { id: "session-1" },
      { id: "session-2" },
    ]);
    expect(commands).toHaveLength(2);
    expect(commands[0]?.input).toMatchObject({
      IndexName: "repositoryId-createdAt",
      KeyConditionExpression: "repositoryId = :repositoryId",
      ExpressionAttributeValues: { ":repositoryId": "repo-1" },
    });
  });

  it("falls back to a filtered scan while the index is unavailable", async () => {
    let queryAttempts = 0;
    const send = async (command: { input: Record<string, unknown> }) => {
      if (command.input.IndexName === "repositoryId-createdAt") {
        queryAttempts += 1;
        const error = new Error("index is still being created");
        error.name = "ValidationException";
        throw error;
      }
      return {
        Items: [{ id: "session-1", repositoryId: "repo-1", createdAt: "2026-01-01" }],
      };
    };
    const ctx = {
      doc: { send },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionsByRepository(ctx, "repo-1")).resolves.toMatchObject([
      { id: "session-1" },
    ]);
    expect(queryAttempts).toBe(1);
  });

  it("normalizes empty index results and propagates unrelated query failures", async () => {
    const empty = {
      doc: { send: async () => ({}) },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByRepository(empty, "repo-1")).resolves.toEqual([]);

    const failed = {
      doc: {
        send: async () => {
          throw new Error("query unavailable");
        },
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;
    await expect(listSessionsByRepository(failed, "repo-1")).rejects.toThrow("query unavailable");
  });

  it("pages the compatibility scan and normalizes an omitted first page", async () => {
    let scans = 0;
    const ctx = {
      doc: {
        send: async (command: { input: Record<string, unknown> }) => {
          if (command.input.IndexName === "repositoryId-createdAt") {
            const error = new Error("index is still being created");
            error.name = "ValidationException";
            throw error;
          }
          scans += 1;
          return scans === 1
            ? { LastEvaluatedKey: { id: "page-1" } }
            : { Items: [{ id: "session-2", repositoryId: "repo-1", createdAt: "2026-01-02" }] };
        },
      },
      tables: { sessions: "Sessions" },
    } as unknown as PlaneStorageCtx;

    await expect(listSessionsByRepository(ctx, "repo-1")).resolves.toMatchObject([
      { id: "session-2" },
    ]);
    expect(scans).toBe(2);
  });
});
