import { describe, expect, it } from "vitest";

import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";

const ctx = createDynamoTestCtx("RepoCreateRace");

describe("durable repository create races", () => {
  it("conditions insert and reconciles the losing cache to DynamoDB", async () => {
    if (!ctx.available || !ctx.storage) return;
    const storage = ctx.storage;
    const options = { storage, now: () => "2026-01-01T00:00:00.000Z" };
    const first = new ControlPlane(options);
    const second = new ControlPlane(options);
    const firstCreate = first.createRepositoryDurable({
      id: "repo-collision",
      name: "repo-first",
      url: "https://example.test/first.git",
    });
    const secondCreate = second.createRepositoryDurable({
      id: "repo-collision",
      name: "repo-second",
      url: "https://example.test/second.git",
    });
    const [firstResult, secondResult] = await Promise.all([firstCreate, secondCreate]);
    expect([firstResult.ok, secondResult.ok]).toContain(true);
    const durable = await storage.getRepository("repo-collision");
    expect(durable).not.toBeNull();
    expect([
      first.getRepository("repo-collision"),
      second.getRepository("repo-collision"),
    ]).toContainEqual(durable);
    expect(first.getRepository("repo-collision")).toEqual(durable);
    expect(second.getRepository("repo-collision")).toEqual(durable);
  });
});
