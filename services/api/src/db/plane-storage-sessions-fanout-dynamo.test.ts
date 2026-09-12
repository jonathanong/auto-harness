import { describe, expect, it } from "vitest";

import {
  createDynamoTestCtx,
  putActiveTestRepository,
} from "../../test-helpers/dynamo-test-helpers.ts";

const dynamo = createDynamoTestCtx("Fanout");

describe("durable session fan-out budget with DynamoDB", () => {
  it("atomically consumes one shared root budget for children and grandchildren", async () => {
    if (!dynamo.storage) {
      expect(true).toBe(true);
      return;
    }
    const storage = dynamo.storage;
    const session = {
      id: "child",
      repositoryId: "repo",
      prompt: "prompt",
      target: { commandId: "command" },
      fallbacks: [],
      targetDisplayNames: ["command"],
      queueTtlSeconds: 60,
      queueExpiresAt: "later",
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "queued" as const,
      queueShard: 0,
      createdAt: "now",
      concurrencyId: "spawn-key",
    };
    await putActiveTestRepository(storage, "repo");
    await storage.putSession({
      ...session,
      id: "root",
      concurrencyId: undefined,
      status: "running",
    });

    await expect(
      storage.createSession(session, [], { id: "root", rootSessionId: "root" }),
    ).resolves.toMatchObject({ created: true });
    await storage.putSession({ ...session, status: "running", sessionApiKeyHash: "attempt-hash" });
    await expect(
      storage.createSession({ ...session, id: "grandchild", concurrencyId: "grandchild-key" }, [], {
        id: "child",
        rootSessionId: "root",
        sessionApiKeyHash: "attempt-hash",
      }),
    ).resolves.toMatchObject({ created: true });

    await expect(storage.getSession("root", true)).resolves.toMatchObject({ descendantCount: 2 });
  });
});
