import { describe, expect, it } from "vitest";

import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { mayAccessRepository } from "./auth-policy.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

/**
 * A host-bound credential is a VPS agent identity. Session creation only checked
 * repository scope, so a stolen daemon key could author work that the scheduler was then
 * free to place on a different host — one host compromise becoming fleet-wide execution.
 */
async function harness() {
  const plane = new ControlPlane({
    idFactory: (() => {
      let n = 0;
      return () => `session-${++n}`;
    })(),
  });
  plane.createRepository({ id: "repo-a", name: "repo-a", url: "/a" });
  plane.createCommand({ id: "cmd-a", name: "echo", argv: ["echo"], providerId: null });
  plane.putSchedule({
    id: "schedule-a",
    repositoryId: "repo-a",
    name: "nightly",
    target: { commandId: "cmd-a" },
    cron: "* * * * *",
    timeout: 10,
    nextRunAt: "2026-01-01T00:00:00.000Z",
  });
  plane.createSession({
    repositoryId: "repo-a",
    prompt: "a",
    target: { commandId: "cmd-a" },
    timeout: 10,
  });
  const session = plane.listSessions()[0]!;

  const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
  // The daemon identity: operator, bound to the host it serves, allowed its repository.
  const { apiKey: hostKey } = await auth.createServiceAccount({
    name: "host-a-agent",
    role: "agent",
    allowedRepositoryIds: ["repo-a"],
    boundHostId: "host-a",
  });
  // Same role and repository scope, but not a host identity.
  const { apiKey: operatorKey } = await auth.createServiceAccount({
    name: "ci",
    role: "operator",
    allowedRepositoryIds: ["repo-a"],
  });
  const { handler } = createLocalApp({
    plane,
    authService: auth,
    rateLimitConfig: { enabled: false },
  });
  const invoke = (method: string, path: string, body: unknown, key: string) =>
    invokeHandler(handler, method, path, body, { authorization: `Bearer ${key}` });

  return { invoke, hostKey, operatorKey, session };
}

describe("session authoring is closed to host-bound credentials", () => {
  it("refuses every route that brings a session into existence", async () => {
    const { invoke, hostKey, session } = await harness();
    const sessionBody = {
      repositoryId: "repo-a",
      prompt: "p",
      target: { commandId: "cmd-a" },
      timeout: 10,
    };
    const scheduleBody = {
      repositoryId: "repo-a",
      name: "from-agent",
      target: { commandId: "cmd-a" },
      cron: "* * * * *",
      timeout: 10,
      nextRunAt: "2026-01-01T00:00:00.000Z",
    };

    const authoringRoutes: Array<[string, string, unknown]> = [
      ["POST", "/api/v1/sessions", sessionBody],
      ["POST", `/api/v1/sessions/${session.id}/clone`, {}],
      ["POST", `/api/v1/sessions/${session.id}/resume`, {}],
      ["POST", "/api/v1/schedules", scheduleBody],
      ["POST", "/api/v1/schedules/schedule-a/trigger", {}],
      ["PATCH", "/api/v1/schedules/schedule-a", { name: "renamed" }],
    ];

    for (const [method, path, body] of authoringRoutes) {
      const res = await invoke(method, path, body, hostKey);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
  });

  it("still allows an equally scoped credential that is not host-bound", async () => {
    const { invoke, operatorKey } = await harness();

    const created = await invoke(
      "POST",
      "/api/v1/sessions",
      { repositoryId: "repo-a", prompt: "p", target: { commandId: "cmd-a" }, timeout: 10 },
      operatorKey,
    );

    expect(created.status).toBe(201);
  });

  it("ignores caller type and schedule source on the public create path", async () => {
    const { invoke, operatorKey } = await harness();

    const spoofed = await invoke(
      "POST",
      "/api/v1/sessions",
      {
        repositoryId: "repo-a",
        prompt: "p",
        target: { commandId: "cmd-a" },
        timeout: 10,
        type: "scheduled",
        source: "schedule",
      },
      operatorKey,
    );
    expect(spoofed.status).toBe(201);
    expect(spoofed.json).toMatchObject({ type: "prompt", source: "api" });

    const webhook = await invoke(
      "POST",
      "/api/v1/sessions",
      {
        repositoryId: "repo-a",
        prompt: "from-ci",
        target: { commandId: "cmd-a" },
        timeout: 10,
        source: "webhook",
      },
      operatorKey,
    );
    expect(webhook.status).toBe(201);
    expect(webhook.json).toMatchObject({ type: "prompt", source: "webhook" });
  });

  it("leaves the agent's own reporting path open", async () => {
    const { invoke, hostKey } = await harness();

    const keepalive = await invoke(
      "POST",
      "/api/v1/host/messages",
      { type: "host:keepalive", hostId: "host-a", at: new Date().toISOString() },
      hostKey,
    );

    expect(keepalive.status).not.toBe(404);
  });
});

describe("mayAccessRepository", () => {
  const scoped = {
    id: "sa-1",
    username: "scoped",
    role: "operator",
    kind: "service-account",
    allowedRepositoryIds: ["repo-a"],
  } as const;

  it("denies a scoped principal when the repository cannot be determined", () => {
    expect(mayAccessRepository(scoped, undefined)).toBe(false);
  });

  it("still allows an unscoped principal and an in-scope repository", () => {
    expect(mayAccessRepository(scoped, "repo-a")).toBe(true);
    expect(mayAccessRepository(scoped, "repo-b")).toBe(false);
    expect(
      mayAccessRepository({ id: "u", username: "u", role: "admin", kind: "admin" }, undefined),
    ).toBe(true);
  });
});
