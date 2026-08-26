import { describe, expect, it } from "vitest";

import { AuthService, type Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import type { SessionRecord } from "./db/types.ts";
import { errorMessage } from "./local-route-errors.ts";
import { handleHostSchedulerRoutes } from "./local-routes-host-scheduler.ts";
import { handleRepositoryRoutes } from "./local-routes-repos-schedules.ts";
import { createLocalApp, startLocalServer } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

function scheduledSession(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "scheduled",
    repositoryId: "repo-a",
    prompt: "maintenance",
    target: { commandId: "command" },
    fallbacks: [],
    targetDisplayNames: ["command"],
    queueTtlSeconds: 3600,
    queueExpiresAt: "2026-01-01T01:00:00.000Z",
    timeout: 10,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: NOW,
    type: "scheduled",
    ...over,
  };
}

describe("local route authorization and outcomes", () => {
  it("normalizes expected and primitive validation errors", () => {
    expect(errorMessage(new Error("credential is invalid"), "invalid account")).toBe(
      "credential is invalid",
    );
    expect(errorMessage("unexpected", "invalid account")).toBe("invalid account");
  });

  it("leaves unknown auth routes unhandled and forwards host notifications", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });
    expect((await invokeHandler(handler, "GET", "/api/v1/auth/unknown")).status).toBe(404);

    const messages: Array<{ hostId: string; message: unknown }> = [];
    const server = await startLocalServer({
      port: 0,
      useDynamo: false,
      enableWs: false,
      plane,
      onHostMessage: (hostId, message) => messages.push({ hostId, message }),
    });
    try {
      plane.registerHost({ hostId: "host-a", worktrees: [], commandProfiles: [] });
      expect(plane.drainHost("host-a")).toEqual({ ok: true, runningSessionIds: [] });
      expect(messages).toEqual([{ hostId: "host-a", message: { type: "host:drain" } }]);
    } finally {
      await server.close();
    }
  });

  it("reports accepted and rejected host messages through the route", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    plane.registerHost({ hostId: "host-a", worktrees: [], commandProfiles: [] });
    const { handler } = createLocalApp({ plane });

    const accepted = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "host-a",
      at: NOW,
    });
    expect(accepted).toMatchObject({ status: 200, json: { ok: true } });

    const rejected = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "missing-host",
      at: NOW,
    });
    expect(rejected).toMatchObject({
      status: 400,
      json: { error: { code: "AGENT_MESSAGE_ERROR" } },
    });
  });

  it("authorizes a bound daemon's own host:status draining message by hostId, not sessionId", async () => {
    // Regression: host:status carries hostId, not sessionId, like host:register/host:keepalive
    // — but a bound principal used to fall through to the sessionId-based branch for it,
    // looking up a session with an undefined id and always 404ing even for its own host.
    const plane = new ControlPlane({ now: () => NOW });
    plane.registerHost({ hostId: "host-a", worktrees: [], commandProfiles: [] });
    plane.registerHost({ hostId: "host-b", worktrees: [], commandProfiles: [] });
    const principal: Principal = {
      id: "service:host-a-daemon",
      kind: "service-account",
      role: "agent",
      boundHostId: "host-a",
    };
    const invoke = (hostId: string) =>
      invokeHandler(
        (req, res) =>
          handleHostSchedulerRoutes({
            plane,
            req: req as never,
            res: res as never,
            url: new URL("/api/v1/host/messages", "http://localhost"),
            method: "POST",
            principal,
          }),
        "POST",
        "/api/v1/host/messages",
        { type: "host:status", hostId, draining: true },
      );

    expect(await invoke("host-a")).toMatchObject({ status: 200, json: { ok: true } });
    expect(await invoke("host-b")).toMatchObject({
      status: 404,
      json: { error: { code: "NOT_FOUND" } },
    });
  });

  it("maps a primitive persistence failure from the storage boundary to an internal error", async () => {
    const plane = new ControlPlane({
      storage: {
        putAuthAccount: async () => {
          throw "storage unavailable";
        },
      } as never,
    });
    const auth = new AuthService({ mode: "disabled", secret: "secret", admins: admins() });
    const { handler } = createLocalApp({ plane, authService: auth });

    const response = await invokeHandler(handler, "POST", "/api/v1/auth/users", {
      username: "alice",
      password: "password",
      role: "operator",
    });
    expect(response).toMatchObject({
      status: 500,
      json: { error: { code: "INTERNAL_ERROR" } },
    });
  });

  it("hides repositories outside a service account's scope during writes", async () => {
    const plane = new ControlPlane();
    plane.createRepository({ id: "repo-a", name: "a", url: "/a" });
    plane.createRepository({ id: "repo-b", name: "b", url: "/b" });
    const principal: Principal = {
      id: "service:scoped",
      kind: "service-account",
      role: "operator",
      allowedRepositoryIds: ["repo-a"],
    };
    const invoke = (method: string, path: string, body?: unknown) =>
      invokeHandler(
        (req, res) =>
          handleRepositoryRoutes({
            plane,
            req: req as never,
            res: res as never,
            url: new URL(path, "http://localhost"),
            method,
            principal,
          }),
        method,
        path,
        body,
      );

    expect((await invoke("PUT", "/api/v1/repositories/repo-b", { name: "hidden" })).status).toBe(
      404,
    );
    expect((await invoke("DELETE", "/api/v1/repositories/repo-b")).status).toBe(404);
  });

  it("hides foreign resumes and maps a scheduled resume failure to conflict", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("scheduled", scheduledSession());
    plane.state.sessions.set(
      "foreign",
      scheduledSession({ id: "foreign", repositoryId: "repo-b", type: "prompt" }),
    );
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { account, apiKey } = await auth.createServiceAccount({
      name: "scoped",
      role: "operator",
      allowedRepositoryIds: ["repo-a"],
    });
    plane.state.sessions.get("scheduled")!.principalId = account.id;
    const { handler } = createLocalApp({ plane, authService: auth });
    const invoke = (path: string) =>
      invokeHandler(handler, "POST", path, {}, { authorization: `Bearer ${apiKey}` });

    expect((await invoke("/api/v1/sessions/foreign/resume")).status).toBe(404);
    const scheduled = await invoke("/api/v1/sessions/scheduled/resume");
    expect(scheduled).toMatchObject({ status: 409, json: { error: { code: "CONFLICT" } } });
  });
});
