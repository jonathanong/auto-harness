import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

describe("concurrency response scope", () => {
  it("does not expose a cross-repository duplicate session", async () => {
    const plane = new ControlPlane();
    plane.createCommand({ id: "cmd-a", name: "echo", argv: ["echo"], providerId: null });
    plane.putSchedule({
      id: "schedule-a",
      repositoryId: "repo-a",
      name: "nightly",
      target: { commandId: "cmd-a" },
      cron: "* * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
      concurrencyId: "shared-cross-repo",
    });
    plane.createSession({
      repositoryId: "repo-b",
      prompt: "secret duplicate",
      target: { commandId: "cmd-a" },
      timeout: 10,
      concurrencyId: "shared-cross-repo",
    });

    const admins = Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
      "base64url",
    );
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins });
    const { apiKey } = await auth.createServiceAccount({
      name: "repo-a-only",
      role: "operator",
      allowedRepositoryIds: ["repo-a"],
    });
    const { handler } = createLocalApp({ plane, authService: auth });
    const invoke = (path: string, body?: unknown) =>
      invokeHandler(handler, "POST", path, body, { authorization: `Bearer ${apiKey}` });

    expect(
      (
        await invoke("/api/v1/sessions", {
          repositoryId: "repo-a",
          prompt: "allowed request",
          target: { commandId: "cmd-a" },
          timeout: 10,
          concurrencyId: "shared-cross-repo",
        })
      ).status,
    ).toBe(404);
    expect((await invoke("/api/v1/schedules/schedule-a/trigger")).status).toBe(404);
  });
});
