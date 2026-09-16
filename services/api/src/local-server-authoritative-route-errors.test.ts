/* eslint-disable max-lines -- table-driven route coverage plus the new Sentry/audit cases. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";
import { initApiSentry, resetApiSentryForTests, type SentryClient } from "./sentry.ts";
import { invokeHandler } from "../test-helpers/local-server-test-helpers.ts";

function fakeSentry(): SentryClient & { captured: unknown[] } {
  const captured: unknown[] = [];
  return {
    captured,
    captureException: (error, hint) => {
      captured.push({ error, hint });
    },
    flush: vi.fn(async () => true),
    init: vi.fn(),
  };
}

const unavailable = async () => {
  throw new Error("storage unavailable");
};

const activeRepository = { id: "repository", admissionState: "active" as const };

const auditStorage = {
  putAuditLog: async () => undefined,
  listAuditLogs: async () => ({ items: [] }),
  listAllAuditLogs: async () => [],
  getRepository: async (id: string) => (id === activeRepository.id ? activeRepository : null),
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
      listWorktreesPage: unavailable,
      getWorktree: unavailable,
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
  targetDisplayNames: ["command"],
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the underlying storage failure to CloudWatch instead of swallowing it", async () => {
    // Regression coverage for a bare `catch { send(res, 500, ...) }` on the hosts and
    // session-target routes: a missing IAM Scan grant (or any storage failure) 500'd with
    // nothing in CloudWatch, which is what made this class of bug hard to diagnose live.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { handler } = createLocalApp({ plane: unavailablePlane() });

    for (const [method, path] of [
      ["GET", "/api/v1/hosts"],
      ["GET", "/api/v1/hosts/host"],
      ["GET", "/api/v1/session-targets"],
      ["GET", "/api/v1/user-sessions"],
      // Newly wired in this change: these previously fell through sendInternalError's
      // no-context call and produced a 500 with zero CloudWatch output.
      ["GET", "/api/v1/commands"],
      ["GET", "/api/v1/providers"],
      ["GET", "/api/v1/worktrees"],
      ["GET", "/api/v1/worktrees/wt-1"],
    ] as const) {
      errorSpy.mockClear();
      const response = await invokeHandler(handler, method, path);
      expect(response.status).toBe(500);
      expect(response.raw).not.toContain("storage unavailable");
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [logged] = errorSpy.mock.calls[0] as [string];
      const parsed = JSON.parse(logged) as { msg: string; method: string; path: string };
      expect(parsed.msg).toMatch(/route failure/);
      expect(parsed.method).toBe(method);
      expect(parsed.path).toBe(path);
    }
  });

  it("reports newly-wired route failures to Sentry without changing the response body", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sentry = fakeSentry();
    initApiSentry({ HARNESS_API_SENTRY_DSN: "https://abc123@o1.ingest.sentry.io/450" }, sentry);
    try {
      const { handler } = createLocalApp({ plane: unavailablePlane() });

      const commands = await invokeHandler(handler, "GET", "/api/v1/commands");
      expect(commands.status).toBe(500);
      expect(commands.json).toEqual({
        error: { code: "INTERNAL_ERROR", message: "unable to persist control-plane state" },
      });

      const worktrees = await invokeHandler(handler, "GET", "/api/v1/worktrees");
      expect(worktrees.status).toBe(500);
      expect(worktrees.json).toEqual({
        error: { code: "INTERNAL_ERROR", message: "internal server error" },
      });

      expect(sentry.captured).toEqual([
        { error: expect.any(Error), hint: { tags: { runtime: "rest" } } },
        { error: expect.any(Error), hint: { tags: { runtime: "rest" } } },
      ]);
      // route-errors.ts never flushes (see its WHY comment) -- that is lambda-handlers.ts's
      // REST wrapper's job, once per invocation, not this in-process local-server path.
      expect(sentry.flush).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      resetApiSentryForTests();
    }
  });

  it("reports an audit-write failure through the central module without double logging", async () => {
    // local-audit.ts's writeRouteAudit/writeSystemAudit gate nearly every mutation route:
    // before this change, an audit-storage failure there 500'd via a bare `catch {}` with
    // no log line at all -- the same class of bug as the route-level ones above.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const plane = new ControlPlane({
      storage: {
        ...auditStorage,
        putAuditLog: async () => {
          throw new Error("audit storage unavailable");
        },
        listCommands: async () => [],
        putCommand: async () => undefined,
      } as never,
    });
    const { handler } = createLocalApp({ plane });

    const response = await invokeHandler(handler, "POST", "/api/v1/commands", {
      name: "echo",
      argv: ["echo"],
    });

    expect(response.status).toBe(500);
    expect(response.json).toEqual({
      error: { code: "INTERNAL_ERROR", message: "unable to persist control-plane state" },
    });
    // Exactly one log line: the create itself succeeded, so only writeRouteAudit's own
    // catch reports -- the route's outer catch (a different failure path) never fires.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logged] = errorSpy.mock.calls[0] as [string];
    const parsed = JSON.parse(logged) as { msg: string; method: string; path: string };
    expect(parsed.msg).toBe("audit route failure");
    expect(parsed.method).toBe("POST");
    expect(parsed.path).toBe("/api/v1/commands");
  });

  it("returns structured errors for every authoritative collection and detail read", async () => {
    const { handler } = createLocalApp({ plane: unavailablePlane() });
    const requests = [
      ["GET", "/api/v1/commands"],
      ["GET", "/api/v1/commands/command"],
      ["GET", "/api/v1/host-inventories"],
      ["GET", "/api/v1/hosts/host/inventory"],
      ["GET", "/api/v1/hosts"],
      ["GET", "/api/v1/hosts/host"],
      ["GET", "/api/v1/user-sessions"],
      ["GET", "/api/v1/worktrees"],
      ["GET", "/api/v1/worktrees/wt-1"],
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

  it("refreshes the durable command catalog before creating with a supplied id", async () => {
    let reads = 0;
    const plane = new ControlPlane({
      storage: {
        ...auditStorage,
        listCommands: async () => {
          reads++;
          return [];
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
    expect(failed.status).toBe(409);

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
