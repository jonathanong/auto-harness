import { describe, expect, it, vi } from "vitest";

import { AuthService, type Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import type { SessionRecord } from "./db/types.ts";
import { createLocalApp, startLocalServer } from "./local-server.ts";
import { handleRepositoryRoutes } from "./local-routes-repos-schedules.ts";
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
    targetLabels: ["command"],
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

describe("local route authorization and outcome coverage", () => {
  it("returns false for unknown auth routes and bridges host messages", async () => {
    const plane = new ControlPlane();
    const { handler } = createLocalApp({ plane });
    expect((await invokeHandler(handler, "GET", "/api/v1/auth/unknown")).status).toBe(404);

    const onHostMessage = vi.fn();
    const server = await startLocalServer({
      port: 0,
      useDynamo: false,
      enableWs: false,
      plane,
      onHostMessage,
    });
    try {
      plane.registerHost({ hostId: "host-a", worktrees: [], commandProfiles: [] });
      expect(plane.drainHost("host-a")).toEqual({ ok: true, runningSessionIds: [] });
      expect(onHostMessage).toHaveBeenCalledWith("host-a", { type: "host:drain" });
    } finally {
      await server.close();
    }
  });

  it("returns a successful response for an accepted legacy host message", async () => {
    const plane = new ControlPlane({ now: () => NOW });
    plane.registerHost({ hostId: "host-a", worktrees: [], commandProfiles: [] });
    const { handler } = createLocalApp({ plane });

    const response = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "host-a",
      at: NOW,
    });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    const rejected = await invokeHandler(handler, "POST", "/api/v1/host/messages", {
      type: "host:keepalive",
      hostId: "missing-host",
      at: NOW,
    });
    expect(rejected.status).toBe(400);
    expect(rejected.json).toMatchObject({ error: { code: "AGENT_MESSAGE_ERROR" } });

    const scopedPlane = new ControlPlane({ now: () => NOW });
    scopedPlane.state.worktrees.set("wt-a", {
      id: "wt-a",
      name: "wt-a",
      hostId: "host-a",
      repositoryId: "repo-a",
      path: "/a/wt",
      labels: [],
      status: "idle",
      online: true,
    });
    scopedPlane.state.hostInventories.set("host-a", {
      hostId: "host-a",
      repositories: [
        {
          id: "repo-b",
          path: "/b",
          defaultBranch: "main",
          worktrees: [{ id: "wt-a", name: "wt-a", path: "/a/wt", labels: [] }],
        },
      ],
      providerAccounts: [],
      commandProfiles: {},
      updatedAt: NOW,
    });
    const scopedAuth = new AuthService({
      mode: "required",
      secret: "b".repeat(32),
      admins: admins(),
    });
    const { apiKey } = await scopedAuth.createServiceAccount({
      name: "host-reader",
      role: "operator",
      allowedRepositoryIds: ["repo-a"],
      boundHostId: "host-a",
    });
    const scopedApp = createLocalApp({ plane: scopedPlane, authService: scopedAuth });
    const hosts = await invokeHandler(scopedApp.handler, "GET", "/api/v1/hosts", undefined, {
      authorization: `Bearer ${apiKey}`,
    });
    expect(hosts.json).toMatchObject({ items: [{ hostId: "host-a" }] });
  });

  it("applies repository scope hiding to updates and deletes", async () => {
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

  it("hides out-of-scope resumes and maps scheduled resume failures to conflicts", async () => {
    const plane = new ControlPlane();
    plane.state.sessions.set("scheduled", scheduledSession());
    plane.state.sessions.set(
      "foreign",
      scheduledSession({ id: "foreign", repositoryId: "repo-b", type: "prompt" }),
    );
    const auth = new AuthService({ mode: "required", secret: "a".repeat(32), admins: admins() });
    const { apiKey } = await auth.createServiceAccount({
      name: "scoped",
      role: "operator",
      allowedRepositoryIds: ["repo-a"],
    });
    const { handler } = createLocalApp({ plane, authService: auth });
    const invoke = (path: string) =>
      invokeHandler(handler, "POST", path, {}, { authorization: `Bearer ${apiKey}` });

    expect((await invoke("/api/v1/sessions/foreign/resume")).status).toBe(404);
    const scheduled = await invoke("/api/v1/sessions/scheduled/resume");
    expect(scheduled.status).toBe(409);
    expect(scheduled.json).toMatchObject({ error: { code: "RESUME_ERROR" } });
  });
});
