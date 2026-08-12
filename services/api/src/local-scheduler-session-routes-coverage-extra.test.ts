import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import type { Principal } from "./auth.ts";
import { handleHostSchedulerRoutes } from "./local-routes-host-scheduler.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";
import { createLocalApp } from "./local-server.ts";

const scheduleBody = {
  repositoryId: "repo",
  name: "nightly",
  target: { commandId: "cmd" },
  cron: "0 * * * *",
  timeout: 30,
};

function app() {
  const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
  plane.createCommand({ id: "cmd", name: "cmd", argv: ["echo"], providerId: null });
  plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo.git" });
  plane.putSchedule({ ...scheduleBody, id: "nightly" });
  const { handler } = createLocalApp({ plane });
  const invoke = (method: string, path: string, body?: unknown) =>
    invokeHandler(handler, method, path, body);
  return { plane, invoke };
}

describe("scheduler and session route residual coverage", () => {
  it("maps an authoritative clone read failure", async () => {
    const { plane, invoke } = app();
    plane.getSessionDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect((await invoke("POST", "/api/v1/sessions/missing/clone", {})).status).toBe(500);
  });

  it("validates create and update schedule refs", async () => {
    const { invoke } = app();
    expect((await invoke("POST", "/api/v1/schedules", { ...scheduleBody, ref: 7 })).status).toBe(
      400,
    );
    expect((await invoke("PATCH", "/api/v1/schedules/nightly", { ref: 7 })).status).toBe(400);
  });

  it("maps every trigger failure class and a thrown backend error", async () => {
    const { plane, invoke } = app();
    for (const [message, status] of [
      ["schedule not found", 404],
      ["schedule is disabled", 409],
      ["invalid schedule cron", 400],
    ] as const) {
      plane.triggerScheduleDurable = async () => ({ ok: false, error: message });
      expect((await invoke("POST", "/api/v1/schedules/nightly/trigger")).status).toBe(status);
    }
    plane.triggerScheduleDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect((await invoke("POST", "/api/v1/schedules/nightly/trigger")).status).toBe(500);
  });

  it("maps schedule update and delete backend failures", async () => {
    const { plane, invoke } = app();
    plane.updateScheduleDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect((await invoke("PATCH", "/api/v1/schedules/nightly", { name: "next" })).status).toBe(500);
    plane.deleteScheduleDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect((await invoke("DELETE", "/api/v1/schedules/nightly")).status).toBe(500);
  });

  it("maps a clone write failure after the source is authorized", async () => {
    const { plane, invoke } = app();
    plane.getSessionDurable = async () => ({
      id: "source",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "cmd" },
      fallbacks: [],
      targetLabels: ["cmd"],
      queueTtlSeconds: 3600,
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "completed",
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "prompt",
      source: "api",
    });
    plane.cloneSessionDurable = async () => {
      throw new Error("storage unavailable");
    };
    expect((await invoke("POST", "/api/v1/sessions/missing/clone", {})).status).toBe(500);
  });

  it("authorizes a host through one of its worktree repositories", async () => {
    const { plane } = app();
    plane.seedWorktree({
      id: "worktree",
      name: "worktree",
      hostId: "host",
      repositoryId: "repo",
      path: "/repo/worktree",
      labels: [],
      status: "idle",
      online: true,
    });
    plane.listHostsDurable = async () => [
      {
        hostId: "host",
        status: "online",
        lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
        worktreeIds: ["worktree"],
        repositoryIds: ["foreign"],
      },
    ];
    const principal: Principal = {
      id: "service:scoped",
      kind: "service-account",
      role: "operator",
      allowedRepositoryIds: ["repo"],
    };
    const response = await invokeHandler(
      (req, res) =>
        handleHostSchedulerRoutes({
          plane,
          req,
          res,
          url: new URL("/api/v1/hosts", "http://localhost"),
          method: "GET",
          principal,
        }),
      "GET",
      "/api/v1/hosts",
    );
    expect(response).toMatchObject({ status: 200, json: { items: [{ hostId: "host" }] } });
  });

  it("maps ordinary resume validation and missing failures", async () => {
    const { plane, invoke } = app();
    const source = {
      id: "source",
      repositoryId: "repo",
      prompt: "run",
      target: { commandId: "cmd" } as const,
      fallbacks: [],
      targetLabels: ["cmd"],
      queueTtlSeconds: 3600,
      timeout: 30,
      priority: 0,
      requiredLabels: [],
      status: "completed" as const,
      queueShard: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      type: "prompt" as const,
      source: "api" as const,
    };
    plane.getSessionDurable = async () => source;
    plane.resumeSessionDurable = async () => ({ ok: false, error: "validation failed" });
    expect((await invoke("POST", "/api/v1/sessions/source/resume", {})).status).toBe(400);
    plane.resumeSessionDurable = async () => ({ ok: false, error: "session not found" });
    expect((await invoke("POST", "/api/v1/sessions/source/resume", {})).status).toBe(404);
  });
});
