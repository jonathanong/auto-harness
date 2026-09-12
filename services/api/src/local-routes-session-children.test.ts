/* eslint-disable max-lines -- route validation, authorization, audit, and pagination share one harness. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-app.ts";
import { invokeBadJson, invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

async function harness() {
  let sequence = 0;
  const plane = new ControlPlane({ idFactory: () => `session-${++sequence}` });
  plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo.git" });
  plane.createCommand({ id: "command", name: "echo", argv: ["echo"], providerId: null });
  const parent = plane.createSession({
    repositoryId: "repo",
    prompt: "parent",
    target: { commandId: "command" },
    timeout: 60,
    priority: 4,
    requiredLabels: ["codex"],
  });
  if (!parent.ok) throw new Error(parent.error);
  plane.forceStatus(parent.session.id, "running");
  const sessionKey = "hns_session_test-key";
  const raw = plane.state.sessions.get(parent.session.id)!;
  raw.sessionApiKeyHash = createHash("sha256").update(sessionKey).digest("hex");
  const auth = new AuthService({
    mode: "required",
    secret: "a".repeat(32),
    admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
      "base64url",
    ),
  });
  const { apiKey } = await auth.createServiceAccount({
    name: "author",
    role: "author",
    allowedRepositoryIds: ["repo"],
  });
  const handler = createLocalApp({
    plane,
    authService: auth,
    rateLimitConfig: { enabled: false },
  }).handler;
  const path = `/api/v1/sessions/${parent.session.id}/children`;
  return { plane, parent: parent.session, sessionKey, apiKey, auth, handler, path };
}

describe("child session route", () => {
  it("omits terminal results from child collection reads", async () => {
    const { handler, path, apiKey, parent, plane } = await harness();
    const rawParent = plane.state.sessions.get(parent.id)!;
    plane.state.sessions.set("terminal-child", {
      ...rawParent,
      id: "terminal-child",
      parentSessionId: parent.id,
      rootSessionId: parent.id,
      status: "completed",
      result: { summary: "private terminal output", summarySource: "agent" },
    });

    const response = await invokeHandler(handler, "GET", path, undefined, {
      authorization: `Bearer ${apiKey}`,
    });

    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ items: [{ id: "terminal-child" }] });
    expect(JSON.stringify(response.json)).not.toContain("private terminal output");
    expect(
      (response.json as { items: Array<Record<string, unknown>> }).items[0],
    ).not.toHaveProperty("result");
  });

  it("creates an inherited child once and never exposes its raw spawn key", async () => {
    const { handler, path, apiKey } = await harness();
    const body = { prompt: "follow up", spawnKey: "private idempotency input", priority: 9 };
    const first = await invokeHandler(handler, "POST", path, body, {
      authorization: `Bearer ${apiKey}`,
    });
    const second = await invokeHandler(handler, "POST", path, body, {
      authorization: `Bearer ${apiKey}`,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(first.json).toMatchObject({
      parentSessionId: "session-1",
      rootSessionId: "session-1",
      priority: 9,
      requiredLabels: ["codex"],
      created: true,
    });
    expect(JSON.stringify(first.json)).not.toContain("private idempotency input");
    expect(second.json).toMatchObject({ id: (first.json as { id: string }).id, created: false });
  });

  it("enforces one root-wide budget across grandchildren while retaining dedupe", async () => {
    const { handler, path, apiKey, plane } = await harness();
    const first = await invokeHandler(
      handler,
      "POST",
      path,
      { prompt: "first", spawnKey: "first" },
      { authorization: `Bearer ${apiKey}` },
    );
    expect(first.status).toBe(201);
    const childId = (first.json as { id: string }).id;
    plane.forceStatus(childId, "running");
    const grandchild = await invokeHandler(
      handler,
      "POST",
      `/api/v1/sessions/${childId}/children`,
      { prompt: "grandchild", spawnKey: "grandchild" },
      { authorization: `Bearer ${apiKey}` },
    );
    expect(grandchild.status).toBe(201);

    const remaining = 62;
    for (let index = 0; index < remaining; index += 1) {
      expect(
        (
          await invokeHandler(
            handler,
            "POST",
            path,
            { prompt: `child-${index}`, spawnKey: `child-${index}` },
            { authorization: `Bearer ${apiKey}` },
          )
        ).status,
      ).toBe(201);
    }
    const exhausted = await invokeHandler(
      handler,
      "POST",
      path,
      { prompt: "over budget", spawnKey: "over-budget" },
      { authorization: `Bearer ${apiKey}` },
    );
    expect(exhausted.status).toBe(409);
    expect(exhausted.json).toMatchObject({ error: { code: "CONFLICT" } });
    const duplicate = await invokeHandler(
      handler,
      "POST",
      path,
      { prompt: "first retry", spawnKey: "first" },
      { authorization: `Bearer ${apiKey}` },
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.json).toMatchObject({ id: childId, created: false });
  });

  it("fails closed when the in-memory lineage root is unavailable", async () => {
    const { handler, path, apiKey, plane, parent } = await harness();
    const first = await invokeHandler(
      handler,
      "POST",
      path,
      { prompt: "first", spawnKey: "first" },
      { authorization: `Bearer ${apiKey}` },
    );
    const childId = (first.json as { id: string }).id;
    plane.forceStatus(childId, "running");
    plane.state.sessions.delete(parent.id);
    const response = await invokeHandler(
      handler,
      "POST",
      `/api/v1/sessions/${childId}/children`,
      { prompt: "grandchild", spawnKey: "grandchild" },
      { authorization: `Bearer ${apiKey}` },
    );
    expect(response.status).toBe(409);
    expect(response.json).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it("accepts a matching current-attempt session token for POST only", async () => {
    const { handler, path, sessionKey } = await harness();
    const created = await invokeHandler(
      handler,
      "POST",
      path,
      { prompt: "child", spawnKey: "one" },
      { authorization: `Bearer ${sessionKey}` },
    );
    expect(created.status).toBe(201);
    expect(
      (
        await invokeHandler(handler, "GET", path, undefined, {
          authorization: `Bearer ${sessionKey}`,
        })
      ).status,
    ).toBe(401);
  });

  it("rejects session tokens after the parent leaves running", async () => {
    const { handler, path, sessionKey, apiKey, plane, parent } = await harness();
    plane.forceStatus(parent.id, "completed");
    const response = await invokeHandler(
      handler,
      "POST",
      path,
      { prompt: "child", spawnKey: "one" },
      { authorization: `Bearer ${sessionKey}` },
    );
    expect(response.status).toBe(401);
    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          path,
          { prompt: "terminal follow-up", spawnKey: "terminal" },
          { authorization: `Bearer ${apiKey}` },
        )
      ).status,
    ).toBe(201);
  });

  it("returns bounded cursor pages and rejects mismatched cursors", async () => {
    const { handler, path, apiKey } = await harness();
    for (const spawnKey of ["one", "two"]) {
      expect(
        (
          await invokeHandler(
            handler,
            "POST",
            path,
            { prompt: spawnKey, spawnKey },
            { authorization: `Bearer ${apiKey}` },
          )
        ).status,
      ).toBe(201);
    }
    const first = await invokeHandler(handler, "GET", `${path}?limit=1`, undefined, {
      authorization: `Bearer ${apiKey}`,
    });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ items: [{ parentSessionId: "session-1" }] });
    const cursor = (first.json as { nextCursor: string }).nextCursor;
    expect(cursor).toMatch(/^s1\./);
    const second = await invokeHandler(
      handler,
      "GET",
      `${path}?limit=1&cursor=${encodeURIComponent(cursor)}`,
      undefined,
      { authorization: `Bearer ${apiKey}` },
    );
    expect(second.status).toBe(200);
    expect(second.json).toMatchObject({
      items: [{ parentSessionId: "session-1" }],
      nextCursor: null,
    });
    expect(
      (
        await invokeHandler(handler, "GET", `${path}?cursor=invalid`, undefined, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(400);
  });

  it("validates every child-only request field", async () => {
    const { handler, path, apiKey } = await harness();
    const invalidBodies: unknown[] = [
      null,
      [],
      { prompt: "child", spawnKey: "key", repositoryId: "repo" },
      { spawnKey: "key" },
      { prompt: "child", spawnKey: 1 },
      { prompt: "child", spawnKey: "" },
      { prompt: "child", spawnKey: "x".repeat(257) },
      { prompt: "child", spawnKey: "line\nbreak" },
      { prompt: "child", spawnKey: "key", priority: "urgent" },
      { prompt: "child", spawnKey: "key", queueTtlSeconds: 1.5 },
      { prompt: "child", spawnKey: "key", queueTtlSeconds: 0 },
      { prompt: "child", spawnKey: "key", queueTtlSeconds: 2_592_001 },
    ];

    for (const body of invalidBodies) {
      const response = await invokeHandler(handler, "POST", path, body, {
        authorization: `Bearer ${apiKey}`,
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.json).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("rejects missing parents, malformed bodies, unsupported methods, and queued parents", async () => {
    const { handler, path, apiKey, plane, parent } = await harness();
    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          "/api/v1/sessions/missing/children",
          {},
          {
            authorization: `Bearer ${apiKey}`,
          },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await invokeHandler(handler, "POST", path, undefined, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(400);
    expect(await invokeBadJson(handler, "POST", path, { authorization: `Bearer ${apiKey}` })).toBe(
      400,
    );
    expect(
      (
        await invokeHandler(handler, "DELETE", path, undefined, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(404);
    plane.forceStatus(parent.id, "queued");
    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          path,
          { prompt: "child", spawnKey: "queued" },
          { authorization: `Bearer ${apiKey}` },
        )
      ).status,
    ).toBe(409);
  });

  it("requires repository access and spawn permission", async () => {
    const { handler, path, auth } = await harness();
    const { apiKey: viewerKey } = await auth.createServiceAccount({
      name: "reader",
      role: "read-only",
      allowedRepositoryIds: ["repo"],
    });
    const { apiKey: otherRepoKey } = await auth.createServiceAccount({
      name: "other-repo",
      role: "author",
      allowedRepositoryIds: ["other"],
    });
    const { apiKey: daemonKey } = await auth.createServiceAccount({
      name: "daemon",
      role: "agent",
      boundHostId: "host-1",
    });

    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          path,
          { prompt: "child", spawnKey: "viewer" },
          { authorization: `Bearer ${viewerKey}` },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await invokeHandler(handler, "GET", path, undefined, {
          authorization: `Bearer ${otherRepoKey}`,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          path,
          { prompt: "child", spawnKey: "daemon" },
          { authorization: `Bearer ${daemonKey}` },
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await invokeHandler(handler, "GET", path, undefined, {
          authorization: `Bearer ${daemonKey}`,
        })
      ).status,
    ).toBe(404);
  });

  it("maps durable admission failures and unexpected failures", async () => {
    const cases = [
      [{ code: "NOT_FOUND", error: "gone" }, 404],
      [{ code: "DRAINING", error: "draining" }, 409],
      [{ code: "REPOSITORY_ADMISSION_CLOSED", error: "closed" }, 409],
    ] as const;

    for (const [failure, status] of cases) {
      const { handler, path, apiKey, plane } = await harness();
      plane.createSessionChildDurable = async () => ({ ok: false, ...failure });
      expect(
        (
          await invokeHandler(
            handler,
            "POST",
            path,
            { prompt: "child", spawnKey: failure.code },
            { authorization: `Bearer ${apiKey}` },
          )
        ).status,
      ).toBe(status);
    }

    const { handler, path, apiKey, plane } = await harness();
    plane.listSessionChildrenDurable = async () => {
      throw new Error("unexpected");
    };
    expect(
      (
        await invokeHandler(handler, "GET", path, undefined, {
          authorization: `Bearer ${apiKey}`,
        })
      ).status,
    ).toBe(500);
  });

  it("allows ordinary child creation when authentication is disabled", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let n = 0;
        return () => `local-${++n}`;
      })(),
    });
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo.git" });
    plane.createCommand({ id: "command", name: "echo", argv: ["echo"], providerId: null });
    const parent = plane.createSession({
      repositoryId: "repo",
      prompt: "parent",
      target: { commandId: "command" },
      timeout: 60,
    });
    if (!parent.ok) throw new Error(parent.error);
    plane.forceStatus(parent.session.id, "running");
    const handler = createLocalApp({ plane, rateLimitConfig: { enabled: false } }).handler;
    expect(
      (
        await invokeHandler(handler, "POST", `/api/v1/sessions/${parent.session.id}/children`, {
          prompt: "child",
          spawnKey: "local",
        })
      ).status,
    ).toBe(201);
  });

  it("fails closed when the mutation audit cannot be persisted", async () => {
    const { handler, path, apiKey, plane } = await harness();
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };

    expect(
      (
        await invokeHandler(
          handler,
          "POST",
          path,
          { prompt: "child", spawnKey: "audit-failure" },
          { authorization: `Bearer ${apiKey}` },
        )
      ).status,
    ).toBe(500);

    const failed = await harness();
    failed.plane.createSessionChildDurable = async () => ({
      ok: false,
      code: "CONFLICT",
      error: "conflict",
    });
    failed.plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    expect(
      (
        await invokeHandler(
          failed.handler,
          "POST",
          failed.path,
          { prompt: "child", spawnKey: "failed-audit" },
          { authorization: `Bearer ${failed.apiKey}` },
        )
      ).status,
    ).toBe(500);
  });
});
