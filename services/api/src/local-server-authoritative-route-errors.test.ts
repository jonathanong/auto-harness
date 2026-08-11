import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { invokeHandler } from "./local-server-test-helpers.ts";

const unavailable = async () => {
  throw new Error("storage unavailable");
};

const auditStorage = {
  putAuditLog: async () => undefined,
  listAuditLogs: async () => ({ items: [] }),
  listAllAuditLogs: async () => [],
};

function unavailablePlane(): ControlPlane {
  return new ControlPlane({
    storage: {
      ...auditStorage,
      getCommand: unavailable,
      getHostInventory: unavailable,
      getProvider: unavailable,
      getProviderAccount: unavailable,
      getRepository: unavailable,
      getSchedule: unavailable,
      getSession: unavailable,
      listAllWorktrees: unavailable,
      listCommands: unavailable,
      listConnections: unavailable,
      listHostInventories: unavailable,
      listProviderAccounts: unavailable,
      listProviders: unavailable,
      listRepositories: unavailable,
      listSchedules: unavailable,
    } as never,
  });
}

const terminalSession = {
  id: "session",
  repositoryId: "repository",
  prompt: "work",
  target: { commandId: "command" },
  fallbacks: [],
  targetLabels: ["command"],
  queueTtlSeconds: 60,
  queueExpiresAt: "2026-01-01T00:01:00.000Z",
  timeout: 1,
  priority: 0,
  requiredLabels: [],
  status: "completed" as const,
  queueShard: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  hostId: "host",
  type: "prompt" as const,
  source: "api" as const,
};

describe("durable route storage errors", () => {
  it("returns structured errors for every authoritative collection and detail read", async () => {
    const { handler } = createLocalApp({ plane: unavailablePlane() });
    const requests = [
      ["GET", "/api/v1/commands"],
      ["GET", "/api/v1/commands/command"],
      ["GET", "/api/v1/host-inventories"],
      ["GET", "/api/v1/hosts/host/inventory"],
      ["GET", "/api/v1/hosts"],
      ["GET", "/api/v1/command-profiles"],
      ["GET", "/api/v1/worktrees"],
      ["GET", "/api/v1/provider-accounts"],
      ["GET", "/api/v1/provider-accounts/account"],
      ["GET", "/api/v1/providers"],
      ["GET", "/api/v1/providers/provider"],
      ["GET", "/api/v1/repositories"],
      ["GET", "/api/v1/repositories/repository"],
      ["GET", "/api/v1/schedules"],
      ["GET", "/api/v1/schedules/schedule"],
      ["POST", "/api/v1/schedules/schedule/trigger"],
      ["GET", "/api/v1/session-targets"],
      ["POST", "/api/v1/sessions/session/cancel"],
      ["POST", "/api/v1/sessions/session/resume"],
    ] as const;

    for (const [method, path] of requests) {
      const response = await invokeHandler(handler, method, path, {});
      expect(response.status).toBe(500);
      expect((response.json as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
    }
  });

  it("returns a structured error when a resume’s durable create fails", async () => {
    const plane = new ControlPlane({
      storage: {
        ...auditStorage,
        getSession: async () => ({ ...terminalSession }),
        createSession: unavailable,
      } as never,
    });
    const { handler } = createLocalApp({ plane });

    const response = await invokeHandler(handler, "POST", "/api/v1/sessions/session/resume", {});
    expect(response.status).toBe(500);
    expect((response.json as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
  });

  it("returns the durable not-found result for a missing command", async () => {
    const plane = new ControlPlane({
      storage: { ...auditStorage, getCommand: async () => null } as never,
    });
    const { handler } = createLocalApp({ plane });

    const response = await invokeHandler(handler, "GET", "/api/v1/commands/missing");
    expect(response.status).toBe(404);
    expect((response.json as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("checks a supplied durable command id before creating it", async () => {
    let reads = 0;
    const plane = new ControlPlane({
      storage: {
        ...auditStorage,
        getCommand: async () => {
          reads++;
          return null;
        },
        putCommand: async () => undefined,
      } as never,
    });

    await expect(
      plane.createCommandDurable({ id: "command", name: "command", argv: ["echo"] }),
    ).resolves.toMatchObject({ ok: true });
    expect(reads).toBe(1);
  });

  it("preserves durable resume outcomes", async () => {
    const unresumable = new ControlPlane({
      storage: {
        ...auditStorage,
        getSession: async () => ({ ...terminalSession, status: "queued" as const }),
      } as never,
    });
    const failed = await invokeHandler(
      createLocalApp({ plane: unresumable }).handler,
      "POST",
      "/api/v1/sessions/session/resume",
      {},
    );
    expect(failed.status).toBe(400);

    const scheduled = new ControlPlane({
      storage: {
        ...auditStorage,
        getSession: async () => ({ ...terminalSession, type: "scheduled" as const }),
      } as never,
    });
    const conflict = await invokeHandler(
      createLocalApp({ plane: scheduled }).handler,
      "POST",
      "/api/v1/sessions/session/resume",
      {},
    );
    expect(conflict.status).toBe(409);

    for (const created of [true, false]) {
      const plane = new ControlPlane({
        storage: {
          ...auditStorage,
          getSession: async () => ({ ...terminalSession }),
          createSession: async (session: typeof terminalSession) => ({ created, session }),
        } as never,
      });
      const response = await invokeHandler(
        createLocalApp({ plane }).handler,
        "POST",
        "/api/v1/sessions/session/resume",
        {},
      );
      expect(response.status).toBe(created ? 201 : 200);
      expect((response.json as { created: boolean }).created).toBe(created);
    }
  });
});
