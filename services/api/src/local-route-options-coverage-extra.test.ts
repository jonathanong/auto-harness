import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleSessionCloneRoute } from "./local-routes-session-clone.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";
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
  createdAt: NOW,
  type: "prompt" as const,
  source: "api" as const,
};

function setup() {
  const plane = new ControlPlane({ now: () => NOW, idFactory: () => "created" });
  plane.createCommand({ id: "cmd", name: "cmd", argv: ["echo"], providerId: null });
  plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo.git" });
  plane.putSchedule({
    id: "nightly",
    repositoryId: "repo",
    name: "nightly",
    target: { commandId: "cmd" },
    cron: "0 * * * *",
    timeout: 30,
  });
  const { handler } = createLocalApp({ plane });
  const invoke = (method: string, path: string, body?: unknown) =>
    invokeHandler(handler, method, path, body);
  return { plane, invoke };
}

describe("local route optional field residual coverage", () => {
  it("passes repository create and update optionals", async () => {
    const { invoke } = setup();
    expect((await invoke("POST", "/api/v1/repositories", {})).status).toBe(400);
    const created = await invoke("POST", "/api/v1/repositories", {
      name: "next",
      url: "https://example.test/next.git",
      defaultBranch: "trunk",
      setupScript: "setup",
    });
    expect(created.status).toBe(201);
    const updated = await invoke("PATCH", "/api/v1/repositories/repo", {
      name: "renamed",
      url: "https://example.test/renamed.git",
    });
    expect(updated).toMatchObject({ status: 200, json: { name: "renamed" } });
    expect(
      (
        await invoke("PATCH", "/api/v1/repositories/repo", {
          url: "https://example.test/final.git",
        })
      ).status,
    ).toBe(200);
  });

  it("passes schedule concurrency through create and update", async () => {
    const { invoke } = setup();
    expect(
      (
        await invoke("POST", "/api/v1/schedules", {
          repositoryId: "repo",
          name: "other",
          target: { commandId: "cmd" },
          cron: "0 * * * *",
          timeout: 30,
          concurrencyId: "one",
        })
      ).status,
    ).toBe(201);
    expect(
      (await invoke("PATCH", "/api/v1/schedules/nightly", { concurrencyId: "two" })).status,
    ).toBe(200);
  });

  it("returns 200 for an idempotent manual trigger", async () => {
    const { plane, invoke } = setup();
    plane.triggerScheduleDurable = async () => ({ ok: true, session: source, created: false });
    expect((await invoke("POST", "/api/v1/schedules/nightly/trigger")).status).toBe(200);
  });

  it("accepts an omitted clone body", async () => {
    const { plane, invoke } = setup();
    plane.getSessionDurable = async () => source;
    plane.cloneSessionDurable = async () => ({ ok: true, session: { ...source, id: "clone" } });
    expect((await invoke("POST", "/api/v1/sessions/source/clone")).status).toBe(201);
    expect((await invoke("POST", "/api/v1/sessions/source/clone", null)).status).toBe(201);
  });

  it("passes the creator and supplies a default clone error code", async () => {
    const { plane } = setup();
    plane.getSessionDurable = async () => source;
    let options: unknown;
    plane.cloneSessionDurable = async (_id, input) => {
      options = input;
      return { ok: false, error: "bad" };
    };
    const principal: Principal = {
      id: "service:operator",
      kind: "service-account",
      role: "operator",
      allowedRepositoryIds: ["repo"],
    };
    const response = await invokeHandler(
      (req, res) =>
        handleSessionCloneRoute({
          plane,
          req,
          res,
          url: new URL("/api/v1/sessions/source/clone", "http://localhost"),
          method: "POST",
          principal,
        }),
      "POST",
      "/api/v1/sessions/source/clone",
      {},
    );
    expect(options).toMatchObject({ createdBy: "service:operator" });
    expect(response).toMatchObject({ status: 400, json: { error: { code: "CLONE_ERROR" } } });
  });
});
