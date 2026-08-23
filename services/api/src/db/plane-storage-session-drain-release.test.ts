import { describe, expect, it } from "vitest";

import {
  claimSessionDrainReconcile,
  releaseSessionDrain,
  updateSessionDrain,
} from "./plane-storage-session-drains.ts";
import type { AuditLogRecord } from "../audit-types.ts";
import type { PlaneStorageCtx, SessionDrainRecord } from "./plane-storage-types.ts";

const conditionalTransaction = {
  name: "TransactionCanceledException",
  CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
};
const conditional = { name: "ConditionalCheckFailedException" };

function record(over: Partial<SessionDrainRecord> = {}): SessionDrainRecord {
  return {
    scopeKey: "repo#principal",
    recordKey: "CURRENT",
    operationId: "operation",
    repositoryId: "repo",
    principalId: "principal",
    status: "draining",
    requestedAt: "now",
    updatedAt: "now",
    deadlineAt: "later",
    queuedCount: 1,
    runningCount: 2,
    cancelledCount: 3,
    ...over,
  };
}

function audit(): AuditLogRecord {
  return {
    id: "audit-session-drain-operation-release",
    createdAt: "now",
    actor: { id: "principal", kind: "service-account", role: "author" },
    action: "session-drain:release",
    resourceType: "repository",
    resourceId: "repo",
    repositoryId: "repo",
    outcome: "success",
    metadata: { operationId: "operation" },
  };
}

function ctx(send: (command: { input?: Record<string, unknown> }) => Promise<unknown>) {
  return {
    doc: { send },
    tables: { sessionDrains: "session-drains" },
  } as unknown as PlaneStorageCtx;
}

describe("session drain update and release races", () => {
  it("only suppresses conditional failures while claiming reconciliation", async () => {
    await expect(
      claimSessionDrainReconcile(
        ctx(async () => Promise.reject(conditional)),
        record(),
        "owner",
        "2026-01-01T00:00:00.000Z",
      ),
    ).resolves.toBeNull();
    await expect(
      claimSessionDrainReconcile(
        ctx(async () => Promise.reject(new Error("offline"))),
        record(),
        "owner",
        "2026-01-01T00:00:00.000Z",
      ),
    ).rejects.toThrow("offline");
  });

  it("classifies update failures without hiding transport failures", async () => {
    await expect(
      updateSessionDrain(
        ctx(async () => ({})),
        record(),
      ),
    ).resolves.toBe(true);
    await expect(
      updateSessionDrain(
        ctx(async () => {
          throw conditionalTransaction;
        }),
        record(),
      ),
    ).resolves.toBe(false);
    await expect(
      updateSessionDrain(
        ctx(async () => {
          throw new Error("offline");
        }),
        record(),
      ),
    ).rejects.toThrow("offline");
  });

  it("classifies release outcomes without hiding transport failures", async () => {
    await expect(
      releaseSessionDrain(
        ctx(async () => ({})),
        record({ status: "released", releasedAt: "now", updatedAt: "now" }),
        audit(),
      ),
    ).resolves.toMatchObject({ status: "released" });
    await expect(
      releaseSessionDrain(
        ctx(async () => ({})),
        record({ status: "released", releasedAt: "now", updatedAt: "now" }),
        audit(),
      ),
    ).resolves.toMatchObject({ status: "released", operationId: "operation" });
    await expect(
      releaseSessionDrain(
        ctx(async (command) => {
          if (command.input?.ConsistentRead) return {};
          throw conditional;
        }),
        record({ status: "released", releasedAt: "now", updatedAt: "now" }),
        audit(),
      ),
    ).resolves.toBeNull();
    await expect(
      releaseSessionDrain(
        ctx(async () => {
          throw new Error("offline");
        }),
        record({ status: "released", releasedAt: "now", updatedAt: "now" }),
        audit(),
      ),
    ).rejects.toThrow("offline");
  });

  it("returns the released operation snapshot without rereading a replacement current drain", async () => {
    let calls = 0;
    const released = record({ status: "released", releasedAt: "now", updatedAt: "now" });
    await expect(
      releaseSessionDrain(
        ctx(async () => {
          calls += 1;
          return calls === 1 ? {} : { Item: record({ operationId: "replacement" }) };
        }),
        released,
        audit(),
      ),
    ).resolves.toEqual(released);
    expect(calls).toBe(1);
  });

  it("replays an already-released operation without accepting a different owner", async () => {
    let call = 0;
    await expect(
      releaseSessionDrain(
        ctx(async (command) => {
          call += 1;
          if (call === 1) throw conditional;
          expect(command.input).toMatchObject({
            Key: { recordKey: "CURRENT" },
            ConsistentRead: true,
          });
          return {
            Item: record({ status: "released", operationId: "operation", releasedAt: "released" }),
          };
        }),
        record({ status: "released", releasedAt: "retry", updatedAt: "retry" }),
        audit(),
      ),
    ).resolves.toMatchObject({ status: "released", releasedAt: "released" });

    call = 0;
    await expect(
      releaseSessionDrain(
        ctx(async () => {
          call += 1;
          if (call === 1) throw conditional;
          return { Item: record({ status: "released", operationId: "different" }) };
        }),
        record({ status: "released", releasedAt: "retry", updatedAt: "retry" }),
        audit(),
      ),
    ).resolves.toBeNull();
  });
});
