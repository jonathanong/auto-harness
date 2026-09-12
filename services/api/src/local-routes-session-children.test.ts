import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-app.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

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
  return { plane, parent: parent.session, sessionKey, apiKey, handler, path };
}

describe("child session route", () => {
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
});
