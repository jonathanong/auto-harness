import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { AuthService } from "./auth.ts";
import { createDynamoTestCtx } from "./db/dynamo-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const dynamo = createDynamoTestCtx("Audit");

describe("durable audit records", () => {
  it("survive hydration, paginate across workers, and fail closed on an append failure", async () => {
    if (!dynamo.available || !dynamo.storage) return;
    let firstId = 0;
    const first = new ControlPlane({
      storage: dynamo.storage,
      now: () => "2026-08-10T00:00:00.000Z",
      auditIdFactory: () => `audit-a${firstId++}`,
    });
    await Promise.all(
      ["one", "two", "three"].map((resourceId) =>
        first.appendAuditLog({
          actor: { id: "system", kind: "system", role: "system" },
          action: "scheduler:cron",
          resourceType: "schedule",
          resourceId,
          outcome: "success",
        }),
      ),
    );
    const second = new ControlPlane({ storage: dynamo.storage });
    await second.hydrateFromStorage();
    const page = await second.listAuditLogs({ limit: 2, action: "scheduler:cron" });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect((await second.listAuditLogs({ limit: 2, cursor: page.nextCursor })).items).toHaveLength(
      1,
    );

    const original = dynamo.storage.putAuditLog.bind(dynamo.storage);
    dynamo.storage.putAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    await expect(
      second.appendAuditLog({
        actor: { id: "system", kind: "system", role: "system" },
        action: "scheduler:assign",
        resourceType: "scheduler",
        resourceId: "queue",
        outcome: "success",
      }),
    ).rejects.toThrow("audit unavailable");
    dynamo.storage.putAuditLog = original;
    expect((await second.listAuditLogs({ action: "scheduler:assign" })).items).toHaveLength(0);

    // DynamoDB cannot atomically combine every existing domain write with an
    // AuditLogs write. The route consequently fails its acknowledgement if the
    // audit append fails; the durable mutation remains visible for recovery.
    const appPlane = new ControlPlane({ storage: dynamo.storage });
    const { handler } = createLocalApp({
      plane: appPlane,
      authService: new AuthService({ mode: "disabled", secret: "audit-test" }),
    });
    dynamo.storage.putAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (
        await invokeHandler(handler, "POST", "/api/v1/repositories", {
          name: "recovery-repo",
          url: "https://example.test/recovery.git",
        })
      ).status,
    ).toBe(500);
    dynamo.storage.putAuditLog = original;
    expect((await dynamo.storage.listRepositories()).map((repo) => repo.name)).toContain(
      "recovery-repo",
    );
  });

  it("never skips matching rows that share a DynamoDB query page", async () => {
    if (!dynamo.available || !dynamo.storage) return;
    let id = 0;
    const plane = new ControlPlane({
      storage: dynamo.storage,
      now: () => "2026-08-10T00:00:00.000Z",
      auditIdFactory: () => `audit-page-${String(id++).padStart(2, "0")}`,
    });
    for (let index = 0; index < 5; index++) {
      await plane.appendAuditLog({
        actor: { id: "system", kind: "system", role: "system" },
        action: "audit:same-page",
        resourceType: "test",
        resourceId: `same-${index}`,
        outcome: "success",
      });
    }
    for (let index = 0; index < 30; index++) {
      await plane.appendAuditLog({
        actor: { id: "system", kind: "system", role: "system" },
        action: index % 2 === 0 ? "audit:filtered-match" : "audit:filtered-skip",
        resourceType: "test",
        resourceId: `filtered-${index}`,
        outcome: "success",
      });
    }

    for (const [action, expected] of [
      ["audit:same-page", 5],
      ["audit:filtered-match", 15],
    ] as const) {
      const records: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await dynamo.storage.listAuditLogs({
          action,
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        records.push(...page.items.map((record) => record.resourceId));
        cursor = page.nextCursor;
      } while (cursor);
      expect(new Set(records)).toHaveLength(expected);
      expect(records).toHaveLength(expected);
    }
  });
});
