import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

describe("session resume ownership", () => {
  it("allows a replacement credential to resume visible terminal work and owns the descendant", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let id = 0;
        return () => `session-${++id}`;
      })(),
    });
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
    plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const original = await auth.createServiceAccount({
      name: "original-automation",
      role: "author",
      allowedRepositoryIds: ["repo"],
    });
    const replacement = await auth.createServiceAccount({
      name: "replacement-automation",
      role: "author",
      allowedRepositoryIds: ["repo"],
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (path: string, body: unknown, key: string) =>
      invokeHandler(handler, "POST", path, body, { authorization: `Bearer ${key}` });

    const created = await invoke(
      "/api/v1/sessions",
      { repositoryId: "repo", prompt: "initial", target: { commandId: "command" }, timeout: 30 },
      original.apiKey,
    );
    expect(created.status).toBe(201);
    const sourceId = (created.json as { id: string }).id;
    Object.assign(plane.state.sessions.get(sourceId)!, { status: "completed", hostId: "host-1" });

    const resumed = await invoke(`/api/v1/sessions/${sourceId}/resume`, {}, replacement.apiKey);

    expect(resumed.status).toBe(201);
    const resumedId = (resumed.json as { id: string }).id;
    expect(plane.state.sessions.get(resumedId)).toMatchObject({
      resumedFromSessionId: sourceId,
      principalId: replacement.account.id,
      metadata: { createdBy: replacement.account.id },
    });
  });
});
