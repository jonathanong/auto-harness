import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";

import {
  putLogFenced,
  skipScheduleForActiveConcurrency,
  tryClaimSchedule,
  tryClaimScheduleAndCreateSession,
} from "./plane-storage-catalog.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

describe("durable schedule creation", () => {
  it("does not treat a failed schedule-cursor condition as a concurrency duplicate", async () => {
    let calls = 0;
    const ctx: PlaneStorageCtx = {
      doc: {
        send: async (command: unknown) => {
          calls += 1;
          expect(command).toBeInstanceOf(TransactWriteCommand);
          throw {
            name: "TransactionCanceledException",
            CancellationReasons: [
              { Code: "ConditionalCheckFailed" },
              { Code: "None" },
              { Code: "None" },
            ],
          };
        },
      } as never,
      tables: {
        sessions: "Sessions",
        worktrees: "Worktrees",
        concurrencyLocks: "ConcurrencyLocks",
        schedules: "Schedules",
      } as never,
    };

    await expect(
      tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule-1",
        expectedNextRunAt: "2026-01-01T00:00:00.000Z",
        newNextRunAt: "2026-01-01T00:01:00.000Z",
        lastRunAt: "2026-01-01T00:00:00.000Z",
        session: {
          id: "session-1",
          repositoryId: "repo-1",
          prompt: "scheduled",
          commandId: "command-1",
          targetLabel: "command",
          timeout: 30,
          priority: 0,
          requiredLabels: [],
          status: "queued",
          queueShard: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          concurrencyId: "schedule-1",
        },
      }),
    ).resolves.toEqual({ kind: "lost" });
    expect(calls).toBe(1);
  });

  it("rethrows unavailable DynamoDB errors instead of misclassifying them as conflicts", async () => {
    const unavailable = {
      doc: { send: async () => Promise.reject(new Error("unavailable")) },
      tables: {},
    } as unknown as PlaneStorageCtx;
    await expect(
      putLogFenced(unavailable, {} as never, { hostId: "host", connectionId: "connection" }),
    ).rejects.toThrow("unavailable");
    await expect(
      tryClaimSchedule(unavailable, "schedule", "before", "after", "last"),
    ).rejects.toThrow("unavailable");
    await expect(
      tryClaimScheduleAndCreateSession(unavailable, {
        scheduleId: "schedule",
        expectedNextRunAt: "before",
        newNextRunAt: "after",
        lastRunAt: "last",
        session: {} as never,
      }),
    ).rejects.toThrow("unavailable");
    await expect(
      skipScheduleForActiveConcurrency(unavailable, {
        scheduleId: "schedule",
        expectedNextRunAt: "before",
        newNextRunAt: "after",
        concurrencyId: "lock",
        sessionId: "session",
      }),
    ).rejects.toThrow("unavailable");
  });

  it("cleans an orphaned concurrency lock after its transaction loses", async () => {
    let reads = 0;
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [
                { Code: "None" },
                { Code: "None" },
                { Code: "ConditionalCheckFailed" },
              ],
            };
          }
          reads += 1;
          return reads === 1 ? { Item: { sessionId: "orphan" } } : {};
        },
      } as never,
      tables: { sessions: "Sessions", concurrencyLocks: "Locks" },
    } as PlaneStorageCtx;
    await expect(
      tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule",
        expectedNextRunAt: "before",
        newNextRunAt: "after",
        lastRunAt: "last",
        session: { id: "new", concurrencyId: "lock" } as never,
      }),
    ).resolves.toEqual({ kind: "lost" });
    expect(reads).toBe(3);
  });

  it("recognizes a running concurrency owner as a duplicate", async () => {
    let reads = 0;
    const ctx = {
      doc: {
        send: async (command: unknown) => {
          if (command instanceof TransactWriteCommand) {
            throw {
              name: "TransactionCanceledException",
              CancellationReasons: [
                { Code: "None" },
                { Code: "None" },
                { Code: "ConditionalCheckFailed" },
              ],
            };
          }
          reads += 1;
          return reads === 1
            ? { Item: { sessionId: "running" } }
            : { Item: { id: "running", status: "running" } };
        },
      } as never,
      tables: { sessions: "Sessions", concurrencyLocks: "Locks" },
    } as PlaneStorageCtx;
    await expect(
      tryClaimScheduleAndCreateSession(ctx, {
        scheduleId: "schedule",
        expectedNextRunAt: "before",
        newNextRunAt: "after",
        lastRunAt: "last",
        session: { id: "new", concurrencyId: "lock" } as never,
      }),
    ).resolves.toMatchObject({ kind: "duplicate", session: { id: "running" } });
  });
});
