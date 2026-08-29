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

describe("session resume timeout upper bound", () => {
  it("rejects a resume timeout override above 604800 seconds and accepts exactly 604800", async () => {
    const plane = new ControlPlane({
      idFactory: (() => {
        let id = 0;
        return () => `session-${++id}`;
      })(),
    });
    plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
    plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const account = await auth.createServiceAccount({
      name: "automation",
      role: "author",
      allowedRepositoryIds: ["repo"],
    });
    const { handler } = createLocalApp({
      plane,
      authService: auth,
      rateLimitConfig: { enabled: false },
    });
    const invoke = (path: string, body: unknown) =>
      invokeHandler(handler, "POST", path, body, { authorization: `Bearer ${account.apiKey}` });

    const created = await invoke("/api/v1/sessions", {
      repositoryId: "repo",
      prompt: "initial",
      target: { commandId: "command" },
      timeout: 30,
    });
    expect(created.status).toBe(201);
    const sourceId = (created.json as { id: string }).id;
    Object.assign(plane.state.sessions.get(sourceId)!, { status: "completed", hostId: "host-1" });

    const rejected = await invoke(`/api/v1/sessions/${sourceId}/resume`, { timeout: 604_801 });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "invalid resume overrides" },
    });

    const accepted = await invoke(`/api/v1/sessions/${sourceId}/resume`, { timeout: 604_800 });
    expect(accepted.status).toBe(201);
    const resumedId = (accepted.json as { id: string }).id;
    expect(plane.state.sessions.get(resumedId)).toMatchObject({ timeout: 604_800 });
  });
});
