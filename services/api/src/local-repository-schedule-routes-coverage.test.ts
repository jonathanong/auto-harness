/* eslint-disable max-lines -- repository and schedule routes share one fixture. */
import { describe, expect, it } from "vitest";

import type { Principal } from "./auth.ts";
import { addDurableReadDefaults } from "./control-plane-durable-read-test-helpers.ts";
import { ControlPlane } from "./control-plane.ts";
import { handleRepositoryRoutes, handleScheduleRoutes } from "./local-routes-repos-schedules.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function invoke(plane: ControlPlane, method: string, path: string, body?: unknown) {
  return invokeHandler(createLocalApp({ plane }).handler, method, path, body);
}

function seededPlane(storage?: object): ControlPlane {
  const plane = new ControlPlane({ storage: storage as never, now: () => NOW });
  plane.state.repositories.set("repository", {
    id: "repository",
    name: "repository",
    url: "/repository",
    defaultBranch: "main",
    createdAt: NOW,
    updatedAt: NOW,
  });
  plane.state.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  plane.state.schedules.set("schedule", {
    id: "schedule",
    repositoryId: "repository",
    name: "schedule",
    target: { commandId: "command" },
    fallbacks: [],
    targetLabels: ["command"],
    cron: "* * * * *",
    enabled: true,
    timeout: 60,
    queueTtlSeconds: 3600,
    nextRunAt: "2026-01-01T00:01:00.000Z",
    lastRunAt: null,
    createdAt: NOW,
    principalId: "system",
    concurrencyId: "schedule-schedule",
  });
  if (storage) addDurableReadDefaults(plane.state);
  return plane;
}

describe("repository and schedule route coverage", () => {
  it("fails closed for scoped repository denials when their audits cannot be stored", async () => {
    const plane = seededPlane();
    plane.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const principal: Principal = {
      id: "scoped",
      kind: "service-account",
      role: "operator",
      allowedRepositoryIds: ["elsewhere"],
    };
    for (const [method, path, body] of [
      ["POST", "/api/v1/repositories/repository/pause", {}],
      ["PATCH", "/api/v1/repositories/repository", { name: "changed" }],
      ["DELETE", "/api/v1/repositories/repository", undefined],
    ] as const) {
      const response = await invokeDirect(
        handleRepositoryRoutes,
        plane,
        method,
        path,
        body,
        principal,
      );
      expect(response.status).toBe(500);
    }
  });

  it("fails closed for repository and schedule outcome audits", async () => {
    const cases = [
      ["DELETE", "/api/v1/repositories/repository", undefined, "repository"],
      ["POST", "/api/v1/schedules/schedule/trigger", {}, "schedule"],
      ["PATCH", "/api/v1/schedules/schedule", { name: "changed" }, "schedule"],
      ["DELETE", "/api/v1/schedules/schedule", undefined, "schedule"],
    ] as const;
    for (const [method, path, body, kind] of cases) {
      const plane = seededPlane();
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      const response = await invokeDirect(
        kind === "repository" ? handleRepositoryRoutes : handleScheduleRoutes,
        plane,
        method,
        path,
        body,
      );
      expect(response.status).toBe(500);
    }
  });

  it("validates typed schedule ref and cursor fields on create and update", async () => {
    const plane = seededPlane();
    const base = {
      repositoryId: "repository",
      name: "new-schedule",
      target: { commandId: "command" },
      cron: "* * * * *",
      timeout: 60,
    };
    for (const body of [
      { ...base, ref: 1 },
      { ...base, nextRunAt: 1 },
      { ...base, prompt: 1 },
    ]) {
      expect((await invoke(plane, "POST", "/api/v1/schedules", body)).status).toBe(400);
    }
    for (const body of [{ ref: 1 }, { nextRunAt: 1 }, { prompt: 1 }]) {
      expect((await invoke(plane, "PATCH", "/api/v1/schedules/schedule", body)).status).toBe(400);
    }
  });

  it("passes every optional repository and schedule field through the routes", async () => {
    const plane = seededPlane();
    expect((await invoke(plane, "POST", "/api/v1/repositories", {})).status).toBe(400);
    expect(
      (
        await invoke(plane, "POST", "/api/v1/repositories", {
          name: "second",
          url: "/second",
          defaultBranch: "trunk",
          setupScript: "setup",
          terminalHookScript: "hook",
        })
      ).status,
    ).toBe(201);
    expect((await invoke(plane, "PATCH", "/api/v1/repositories/second", {})).status).toBe(404);

    const created = await invoke(plane, "POST", "/api/v1/schedules", {
      id: "second-schedule",
      repositoryId: "repository",
      name: "second",
      target: { commandId: "command" },
      fallbacks: [],
      cron: "*/5 * * * *",
      timeout: 30,
      queueTtlSeconds: 120,
      nextRunAt: "2026-01-01T00:05:00.000Z",
      enabled: false,
      ref: "feature/test",
      concurrencyId: "group",
      prompt: "  review the repo  ",
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ prompt: "review the repo" });
    const updated = await invoke(plane, "PATCH", "/api/v1/schedules/second-schedule", {
      repositoryId: "repository",
      name: "changed",
      target: { commandId: "command" },
      fallbacks: [],
      cron: "*/10 * * * *",
      timeout: 45,
      queueTtlSeconds: 180,
      nextRunAt: "2026-01-01T00:10:00.000Z",
      enabled: true,
      ref: "feature/changed",
      concurrencyId: "changed-group",
      prompt: "lint the tree",
    });
    expect(updated.status).toBe(200);
    expect(updated.json).toMatchObject({ prompt: "lint the tree" });
    const triggered = await invoke(plane, "POST", "/api/v1/schedules/second-schedule/trigger", {});
    expect(triggered).toMatchObject({
      status: 201,
      json: { prompt: "lint the tree", type: "scheduled", source: "schedule" },
    });
  });

  it("maps an otherwise valid trigger failure to TRIGGER_ERROR", async () => {
    const plane = seededPlane();
    plane.state.schedules.get("schedule")!.cron = "invalid";
    const response = await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {});
    expect(response).toMatchObject({ status: 400, json: { error: { code: "TRIGGER_ERROR" } } });
  });

  it("returns an existing active scheduled session from a duplicate trigger", async () => {
    const plane = seededPlane();
    expect((await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {})).status).toBe(
      201,
    );
    const duplicate = await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {});
    expect(duplicate).toMatchObject({ status: 200, json: { created: false } });
  });

  it("maps schedule write failures to internal errors", async () => {
    const create = seededPlane({
      putSchedule: async () => {
        throw new Error("write failed");
      },
    });
    expect(
      (
        await invoke(create, "POST", "/api/v1/schedules", {
          id: "new",
          repositoryId: "repository",
          name: "new",
          target: { commandId: "command" },
          cron: "* * * * *",
          timeout: 1,
        })
      ).status,
    ).toBe(500);

    const update = seededPlane({
      updateScheduleManagement: async () => {
        throw new Error("write failed");
      },
    });
    expect(
      (await invoke(update, "PATCH", "/api/v1/schedules/schedule", { name: "new" })).status,
    ).toBe(500);

    const remove = seededPlane({
      deleteSchedule: async () => {
        throw new Error("write failed");
      },
    });
    expect((await invoke(remove, "DELETE", "/api/v1/schedules/schedule")).status).toBe(500);
  });

  it("maps a durable trigger transaction failure to an internal error", async () => {
    const plane = seededPlane({
      tryClaimScheduleAndCreateSession: async () => {
        throw new Error("claim failed");
      },
    });
    plane.state.schedules.get("schedule")!.principalId = "principal";
    const response = await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {});
    expect(response).toMatchObject({ status: 500, json: { error: { code: "INTERNAL_ERROR" } } });
  });

  it("maps repository deletion conflicts with and without dependency details", async () => {
    for (const result of [
      {
        ok: false,
        conflict: true,
        error: "repository has dependents",
        dependencies: { schedules: ["schedule"] },
      },
      { ok: false, conflict: false, error: "repository missing" },
    ] as const) {
      const plane = seededPlane();
      plane.deleteRepositoryDurable = async () => result as never;
      const response = await invoke(plane, "DELETE", "/api/v1/repositories/repository");
      expect(response.status).toBe(result.conflict ? 409 : 404);
      expect(response.json).toMatchObject({
        error: { code: result.conflict ? "CONFLICT" : "NOT_FOUND" },
      });
    }
  });

  it("maps draining and categorized schedule trigger failures", async () => {
    for (const [result, status, code] of [
      [
        { ok: false, code: "DRAINING", error: "draining", operationId: "operation/id" },
        409,
        "DRAINING",
      ],
      [{ ok: false, error: "schedule not found" }, 404, "NOT_FOUND"],
      [{ ok: false, error: "repository admission is paused" }, 409, "REPOSITORY_ADMISSION_CLOSED"],
      [{ ok: false, error: "schedule already active" }, 409, "CONFLICT"],
    ] as const) {
      const plane = seededPlane();
      plane.triggerScheduleDurable = async () => result as never;
      const response = await invoke(plane, "POST", "/api/v1/schedules/schedule/trigger", {});
      expect(response).toMatchObject({ status, json: { error: { code } } });
      if ("operationId" in result) {
        expect(response.json).toMatchObject({
          error: {
            operationId: "operation/id",
            statusUrl: "/api/v1/repositories/repository/session-drains/operation%2Fid",
          },
        });
      }
    }
  });

  it("backfills a missing schedule principal during update", async () => {
    const plane = seededPlane();
    plane.state.schedules.get("schedule")!.principalId = "";
    let principalId: string | undefined;
    plane.updateScheduleDurable = async (_id, input) => {
      principalId = input.principalId;
      return { ok: true, schedule: plane.state.schedules.get("schedule")! };
    };
    expect(
      (await invoke(plane, "PATCH", "/api/v1/schedules/schedule", { name: "updated" })).status,
    ).toBe(200);
    expect(principalId).toBe("system");
  });

  it("fails closed when repository-admission outcome audits cannot be stored", async () => {
    for (const outcome of ["success", "failure", "throw"] as const) {
      const plane = seededPlane();
      plane.appendAuditLog = async () => {
        throw new Error("audit unavailable");
      };
      if (outcome === "failure") {
        plane.pauseRepositoryDurable = async () => ({
          ok: false,
          code: "NOT_FOUND",
          error: "missing",
        });
      } else if (outcome === "throw") {
        plane.pauseRepositoryDurable = async () => {
          throw new Error("write failed");
        };
      }
      expect(
        (await invoke(plane, "POST", "/api/v1/repositories/repository/pause", {})).status,
      ).toBe(500);
    }
  });

  it("covers schedule deletion audits when the authoritative row disappeared", async () => {
    for (const outcome of ["failure", "success", "throw"] as const) {
      const plane = seededPlane();
      plane.getScheduleDurable = async () => null;
      if (outcome === "failure") {
        plane.deleteScheduleDurable = async () => ({ ok: false, error: "missing" });
      } else if (outcome === "success") {
        plane.deleteScheduleDurable = async () => ({ ok: true });
      } else {
        plane.deleteScheduleDurable = async () => {
          throw new Error("delete failed");
        };
      }
      expect((await invoke(plane, "DELETE", "/api/v1/schedules/missing")).status).toBe(
        outcome === "failure" ? 404 : outcome === "success" ? 204 : 500,
      );
    }
  });

  it("covers denied and terminal route audits that stop before writing a response", async () => {
    const denied = seededPlane();
    denied.appendAuditLog = async () => {
      throw new Error("audit unavailable");
    };
    const principal: Principal = {
      id: "scoped",
      kind: "service-account",
      role: "operator",
      allowedRepositoryIds: ["elsewhere"],
    };
    expect(
      (
        await invokeDirect(
          handleRepositoryRoutes,
          denied,
          "POST",
          "/api/v1/repositories/repository/pause",
          {},
          principal,
        )
      ).status,
    ).toBe(500);
  });

  it("audits trigger failures without a repository and hides a scoped result", async () => {
    const missing = seededPlane();
    missing.getScheduleDurable = async () => null;
    missing.triggerScheduleDurable = async () => {
      throw new Error("trigger failed");
    };
    expect((await invoke(missing, "POST", "/api/v1/schedules/missing/trigger", {})).status).toBe(
      500,
    );

    const outOfScope = seededPlane();
    outOfScope.triggerScheduleDurable = async () =>
      ({
        ok: true,
        created: true,
        session: { id: "session", repositoryId: "repository" },
      }) as never;
    const principal: Principal = {
      id: "scoped",
      kind: "service-account",
      role: "operator",
      allowedRepositoryIds: ["elsewhere"],
    };
    expect(
      (
        await invokeDirect(
          handleScheduleRoutes,
          outOfScope,
          "POST",
          "/api/v1/schedules/schedule/trigger",
          {},
          principal,
        )
      ).status,
    ).toBe(404);

    const resultOutOfScope = seededPlane();
    resultOutOfScope.triggerScheduleDurable = async () =>
      ({
        ok: true,
        created: true,
        session: { id: "session", repositoryId: "elsewhere" },
      }) as never;
    expect(
      (
        await invokeDirect(
          handleScheduleRoutes,
          resultOutOfScope,
          "POST",
          "/api/v1/schedules/schedule/trigger",
          {},
          {
            id: "scoped",
            kind: "service-account",
            role: "operator",
            allowedRepositoryIds: ["repository"],
          },
        )
      ).status,
    ).toBe(404);
  });

  it("covers schedule mutation audits when legacy rows omit repositoryId", async () => {
    const legacy = seededPlane();
    const schedule = legacy.state.schedules.get("schedule")!;
    const withoutRepository = { ...schedule, repositoryId: undefined } as never;
    legacy.getScheduleDurable = async () => withoutRepository;
    legacy.updateScheduleDurable = async () => ({ ok: false, error: "invalid" }) as never;
    expect((await invoke(legacy, "PATCH", "/api/v1/schedules/schedule", {})).status).toBe(400);

    const thrown = seededPlane();
    thrown.getScheduleDurable = async () => withoutRepository;
    thrown.updateScheduleDurable = async () => {
      throw new Error("update failed");
    };
    expect((await invoke(thrown, "PATCH", "/api/v1/schedules/schedule", {})).status).toBe(500);

    const deleted = seededPlane();
    deleted.getScheduleDurable = async () => withoutRepository;
    deleted.deleteScheduleDurable = async () => ({ ok: false, error: "missing" });
    expect((await invoke(deleted, "DELETE", "/api/v1/schedules/schedule")).status).toBe(404);

    const hiddenRepositoryUpdate = seededPlane();
    expect(
      (
        await invokeDirect(
          handleScheduleRoutes,
          hiddenRepositoryUpdate,
          "PATCH",
          "/api/v1/schedules/schedule",
          { repositoryId: "elsewhere" },
          {
            id: "scoped",
            kind: "service-account",
            role: "operator",
            allowedRepositoryIds: ["repository"],
          },
        )
      ).status,
    ).toBe(404);
  });
});

async function invokeDirect(
  handler: typeof handleRepositoryRoutes,
  plane: ControlPlane,
  method: string,
  path: string,
  body?: unknown,
  principal?: Principal,
) {
  return invokeHandler(
    (req, res) =>
      handler({
        plane,
        req,
        res,
        url: new URL(path, "http://localhost"),
        method,
        ...(principal ? { principal } : {}),
      }),
    method,
    path,
    body,
  );
}
