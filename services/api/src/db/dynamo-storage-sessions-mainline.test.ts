import { describe, expect, it } from "vitest";

import { createSession, listAllSessions, listAllWorktrees } from "./plane-storage-sessions.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const marker = [{ key: "repository:repo", now: "now" }];
const session = (extra: Record<string, unknown> = {}) =>
  ({
    id: "session",
    repositoryId: "repo",
    prompt: "prompt",
    target: { commandId: "command" },
    fallbacks: [],
    targetLabels: ["command"],
    queueTtlSeconds: 60,
    queueExpiresAt: "later",
    timeout: 60,
    priority: 0,
    requiredLabels: [],
    status: "queued",
    queueShard: 0,
    createdAt: "now",
    ...extra,
  }) as never;
const ctx = (send: (command: unknown) => Promise<unknown>) =>
  ({
    doc: { send },
    tables: { sessions: "sessions", concurrencyLocks: "locks", worktrees: "worktrees" },
  }) as unknown as PlaneStorageCtx;
const cancelled = (failedIndex: number, count = 3) => ({
  name: "TransactionCanceledException",
  CancellationReasons: Array.from({ length: count }, (_, index) => ({
    Code: index === failedIndex ? "ConditionalCheckFailed" : "None",
  })),
});

describe("Dynamo session adapter mainline additions", () => {
  it("creates marker-fenced plain sessions and distinguishes marker and id conflicts", async () => {
    await expect(
      createSession(
        ctx(async () => ({})),
        session(),
        marker,
      ),
    ).resolves.toMatchObject({
      created: true,
    });
    await expect(
      createSession(
        ctx(async () => {
          throw cancelled(2);
        }),
        session(),
        marker,
      ),
    ).rejects.toThrow("session id collision: session");
    await expect(
      createSession(
        ctx(async () => {
          throw cancelled(0);
        }),
        session(),
        marker,
      ),
    ).rejects.toThrow("catalog deletion is in progress");
  });

  it("rejects a marker-fenced concurrent session when catalog deletion wins", async () => {
    await expect(
      createSession(
        ctx(async () => {
          throw cancelled(0, 4);
        }),
        session({ concurrencyId: "key" }),
        marker,
      ),
    ).rejects.toThrow("catalog deletion is in progress");
  });

  it("sets a consistent read when listing all worktrees", async () => {
    await expect(
      listAllSessions(
        ctx(async () => ({})),
        true,
      ),
    ).resolves.toEqual([]);
    await expect(
      listAllWorktrees(
        ctx(async () => ({})),
        true,
      ),
    ).resolves.toEqual([]);
  });
});
