import { describe, expect, it, vi } from "vitest";

import type { AuditLogRecord } from "../audit-types.ts";
import { auditLogItem, listAllAuditLogs, listAuditLogs } from "./plane-storage-audit.ts";
import type { PlaneStorageCtx } from "./plane-storage-types.ts";

const record: AuditLogRecord = {
  id: "audit-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  actor: { id: "actor", kind: "user", role: "admin" },
  action: "session:create",
  resourceType: "session",
  resourceId: "session-1",
  repositoryId: "repo-1",
  outcome: "success",
  metadata: {},
};

function ctx(send: PlaneStorageCtx["doc"]["send"]): PlaneStorageCtx {
  return { doc: { send } as never, tables: { auditLogs: "AuditLogs" } as never } as PlaneStorageCtx;
}

describe("audit storage branch coverage", () => {
  it("rejects every malformed cursor shape", async () => {
    for (const value of [null, {}, { scope: "wrong", timestampId: "id" }, { scope: "audit" }]) {
      const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
      await expect(listAuditLogs(ctx(vi.fn()), { cursor })).rejects.toThrow("invalid audit cursor");
    }
  });

  it("applies every optional filter and returns a cursor within a physical page", async () => {
    const send = vi.fn().mockResolvedValue({
      Items: [auditLogItem(record), auditLogItem({ ...record, id: "audit-2" })],
    });
    const context = ctx(send);
    await expect(
      listAuditLogs(context, {
        limit: 1,
        actorId: "actor",
        action: "session:create",
        resourceType: "session",
        resourceId: "session-1",
        repositoryId: "repo-1",
        outcome: "success",
      }),
    ).resolves.toMatchObject({ items: [{ id: "audit-1" }], nextCursor: expect.any(String) });

    for (const query of [
      { actorId: "other" },
      { action: "other" },
      { resourceType: "other" },
      { resourceId: "other" },
      { repositoryId: "other" },
      { outcome: "failed" as const },
    ]) {
      await expect(listAuditLogs(context, query)).resolves.toEqual({ items: [] });
    }
  });

  it("consumes sparse pages, handles absent Items, and resumes all-record listings", async () => {
    const sparse = vi
      .fn()
      .mockResolvedValueOnce({ LastEvaluatedKey: { scope: "audit", timestampId: "cursor" } })
      .mockResolvedValueOnce({ Items: [auditLogItem(record)] });
    await expect(listAuditLogs(ctx(sparse), { limit: 1 })).resolves.toEqual({ items: [record] });
    expect(sparse.mock.calls[1]?.[0].input.ExclusiveStartKey).toEqual({
      scope: "audit",
      timestampId: "cursor",
    });

    const hundred = Array.from({ length: 100 }, (_, index) =>
      auditLogItem({ ...record, id: `audit-${index}` }),
    );
    const all = vi
      .fn()
      .mockResolvedValueOnce({
        Items: hundred,
        LastEvaluatedKey: { scope: "audit", timestampId: "next" },
      })
      .mockResolvedValueOnce({ Items: [auditLogItem({ ...record, id: "last" })] });
    await expect(listAllAuditLogs(ctx(all))).resolves.toHaveLength(101);
  });
});
