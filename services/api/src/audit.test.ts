/* eslint-disable max-lines -- immutable audit access and query coverage share one contract. */
import { describe, expect, it } from "vitest";

import { auditActor, newAuditRecord, sanitizeAuditMetadata, SYSTEM_AUDIT_ACTOR } from "./audit.ts";
import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function basic(username: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

describe("audit records", () => {
  it("bounds metadata and excludes secret-bearing fields", () => {
    const metadata = sanitizeAuditMetadata({
      okay: "x".repeat(300),
      count: 2,
      enabled: true,
      labels: ["one", "two"],
      nested: { ignored: true },
      invalid: Number.NaN,
      password: "nope",
      authToken: "nope",
    });
    expect(metadata).toEqual({
      okay: "x".repeat(256),
      count: 2,
      enabled: true,
      labels: ["one", "two"],
    });
    expect(sanitizeAuditMetadata()).toEqual({});
    const capped = sanitizeAuditMetadata(
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i])),
    );
    expect(Object.keys(capped)).toHaveLength(16);
    expect(auditActor(undefined)).toEqual({
      id: "anonymous",
      kind: "anonymous",
      role: "anonymous",
    });
    expect(SYSTEM_AUDIT_ACTOR).toEqual({ id: "system", kind: "system", role: "system" });
    expect(
      newAuditRecord(
        {
          actor: SYSTEM_AUDIT_ACTOR,
          action: "scheduler:cron",
          resourceType: "scheduler",
          resourceId: "cron",
          outcome: "success",
        },
        "2026-08-10T00:00:00.000Z",
        "audit-fixed",
      ),
    ).toMatchObject({ id: "audit-fixed", createdAt: "2026-08-10T00:00:00.000Z", metadata: {} });
  });

  it("lists in-memory records with exact filters and opaque cursors", async () => {
    let count = 0;
    const plane = new ControlPlane({
      now: () => `2026-08-10T00:00:0${count}.000Z`,
      auditIdFactory: () => `audit-${count++}`,
    });
    await plane.appendAuditLog({
      actor: { id: "user:a", kind: "user", role: "operator" },
      action: "session:create",
      resourceType: "session",
      resourceId: "s1",
      repositoryId: "repo-a",
      outcome: "success",
      metadata: { prompt: "must disappear", target: "cmd" },
    });
    await plane.appendAuditLog({
      actor: { id: "user:b", kind: "user", role: "admin" },
      action: "repository:update",
      resourceType: "repository",
      resourceId: "repo-b",
      repositoryId: "repo-b",
      outcome: "failed",
    });
    await plane.appendAuditLog({
      actor: { id: "user:a", kind: "user", role: "operator" },
      action: "session:cancel",
      resourceType: "session",
      resourceId: "s2",
      repositoryId: "repo-a",
      outcome: "denied",
    });
    const page = await plane.listAuditLogs({ limit: 2 });
    expect(page.items.map((item) => item.id)).toEqual(["audit-2", "audit-1"]);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect((await plane.listAuditLogs({ limit: 2, cursor: page.nextCursor })).items).toMatchObject([
      { id: "audit-0", metadata: { target: "cmd" } },
    ]);
    expect((await plane.listAuditLogs({ actorId: "user:a" })).items).toHaveLength(2);
    expect((await plane.listAuditLogs({ action: "repository:update" })).items).toMatchObject([
      { outcome: "failed", resourceId: "repo-b" },
    ]);
    expect(
      (await plane.listAuditLogs({ resourceType: "session", outcome: "denied" })).items,
    ).toHaveLength(1);
    expect(
      (await plane.listAuditLogs({ repositoryId: "repo-a", resourceId: "s1" })).items,
    ).toHaveLength(1);
    await expect(plane.listAuditLogs({ cursor: "not-a-cursor" })).rejects.toThrow(
      "invalid audit cursor",
    );
  });

  it("exposes immutable history only to authenticated admins", async () => {
    const plane = new ControlPlane({ auditIdFactory: () => "audit-admin" });
    await plane.appendAuditLog({
      actor: { id: "user:a", kind: "user", role: "operator" },
      action: "session:create",
      resourceType: "session",
      resourceId: "s1",
      outcome: "success",
    });
    await plane.appendAuditLog({
      actor: { id: "user:b", kind: "user", role: "admin" },
      action: "session:clone",
      resourceType: "session",
      resourceId: "s2",
      repositoryId: "repo-a",
      outcome: "success",
    });
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({ name: "reader", role: "read-only" });
    const { apiKey: scopedAdminKey } = await auth.createServiceAccount({
      name: "scoped-admin",
      role: "maintainer",
      allowedRepositoryIds: ["repo-a"],
    });
    const { apiKey: hostBoundAdminKey } = await auth.createServiceAccount({
      name: "host-bound-admin",
      role: "agent",
      boundHostId: "host-a",
    });
    const { handler } = createLocalApp({ plane, authService: auth });
    const adminPage = await invokeHandler(
      handler,
      "GET",
      "/api/v1/audit-logs?limit=1",
      undefined,
      basic("root", "root"),
    );
    expect(adminPage.status).toBe(200);
    expect(adminPage.json).toMatchObject({
      items: [{ id: "audit-admin", actor: { id: "user:b" } }],
    });
    expect(
      (
        await invokeHandler(
          handler,
          "GET",
          "/api/v1/audit-logs?actorId=user:a&action=session%3Acreate&resourceType=session&resourceId=s1&repositoryId=repo-a&outcome=success",
          undefined,
          basic("root", "root"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await invokeHandler(handler, "GET", "/api/v1/audit-logs", undefined, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeHandler(handler, "GET", "/api/v1/audit-logs", undefined, {
          authorization: `Bearer ${hostBoundAdminKey}`,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeHandler(handler, "GET", "/api/v1/audit-logs", undefined, {
          authorization: `Bearer ${scopedAdminKey}`,
        })
      ).status,
    ).toBe(403);
    expect((await invokeHandler(handler, "GET", "/api/v1/audit-logs")).status).toBe(401);
    expect(
      (
        await invokeHandler(
          handler,
          "GET",
          "/api/v1/audit-logs?limit=0",
          undefined,
          basic("root", "root"),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await invokeHandler(
          handler,
          "GET",
          "/api/v1/audit-logs?outcome=other",
          undefined,
          basic("root", "root"),
        )
      ).status,
    ).toBe(400);
    expect(
      (await invokeHandler(handler, "POST", "/api/v1/audit-logs", {}, basic("root", "root")))
        .status,
    ).toBe(404);
  });
});
