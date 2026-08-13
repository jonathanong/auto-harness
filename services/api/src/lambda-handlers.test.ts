/* eslint-disable max-lines -- Lambda ingress fencing and delivery lifecycle share one fixture. */
import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { createLambdaHandlers, createLambdaRuntime } from "./lambda-handlers.ts";

function hostPrincipal(hostId = "host-1") {
  return {
    id: "service-1",
    username: "daemon",
    kind: "service-account" as const,
    role: "operator" as const,
    boundHostId: hostId,
  };
}

function runtimeFixture(principal: ReturnType<typeof hostPrincipal> | null = hostPrincipal()) {
  const connections = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const hostLocks = new Map<string, string>();
  const deletedConnections: string[] = [];
  const registrations: Array<Record<string, unknown>> = [];
  const storage = {
    async acknowledgeSession() {
      return true;
    },
    async deleteConnection(id: string) {
      deletedConnections.push(id);
      connections.delete(id);
    },
    async getConnection(id: string) {
      return connections.get(id) ?? null;
    },
    async getHostLock(hostId: string) {
      return hostLocks.get(hostId) ?? null;
    },
    async getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    async getWorktree() {
      return null;
    },
    async listCommands() {
      return [];
    },
    async listConnections() {
      return [...connections.values()];
    },
    async listHostInventories() {
      return [];
    },
    async listProviderAccounts() {
      return [];
    },
    async listProviders() {
      return [];
    },
    async listWorktreesByHost() {
      return [];
    },
    async markHostDraining(hostId: string, connectionId: string) {
      return hostLocks.get(hostId) === connectionId;
    },
    async putConnection(connection: Record<string, unknown>) {
      connections.set(String(connection.connectionId), connection);
    },
    async putHostInventory() {},
    async putWorktreeFenced() {
      return true;
    },
    async releaseHostConnection(hostId: string, connectionId: string) {
      if (hostLocks.get(hostId) !== connectionId) return false;
      hostLocks.delete(hostId);
      connections.delete(connectionId);
      return true;
    },
    async setWorktreeOnlineFenced() {
      return true;
    },
    async tryRegisterHost(input: Record<string, unknown>) {
      registrations.push(input);
      const connection = input.connection as Record<string, unknown>;
      const connectionId = String(connection.connectionId);
      const hostId = String(input.hostId);
      const pending = connections.get(connectionId);
      if (
        input.consumePendingConnection === true &&
        (!pending ||
          pending.registered !== false ||
          pending.connectionId !== connectionId ||
          pending.hostId !== hostId)
      )
        return false;
      const owner = hostLocks.get(hostId);
      if (owner && input.replaceExisting !== true) return false;
      if (owner && owner !== connectionId) connections.delete(owner);
      connections.set(connectionId, connection);
      hostLocks.set(hostId, connectionId);
      return true;
    },
  };
  const plane = new ControlPlane({
    attemptIdFactory: () => "attempt-1",
    connectionIdFactory: () => "gateway-1",
    now: () => "2026-08-12T00:00:00.000Z",
    storage: storage as never,
  });
  const auth = { authenticate: vi.fn(async () => principal) };
  const management = { send: vi.fn(async () => ({})) };
  return {
    auth,
    connections,
    deletedConnections,
    hostLocks,
    management,
    plane,
    registrations,
    runtime: createLambdaRuntime({
      auth: auth as never,
      created: { plane, storage } as never,
      management,
    }),
    sessions,
    storage,
  };
}

async function registerGatewayHost(
  fixture: ReturnType<typeof runtimeFixture>,
  connectionId = "gateway-1",
) {
  const runtime = await fixture.runtime;
  await runtime.websocket({
    requestContext: { connectionId, routeKey: "$connect" },
  });
  await runtime.websocket({
    body: JSON.stringify({
      type: "host:register",
      hostId: "host-1",
      worktrees: [],
      commandProfiles: [],
    }),
    requestContext: { connectionId, routeKey: "$default" },
  });
  return runtime;
}

describe("Lambda runtime adapters", () => {
  it("authenticates connect once and fences the socket to its bound host", async () => {
    const fixture = runtimeFixture();
    const runtime = await fixture.runtime;
    const connect = {
      headers: { authorization: "Bearer hns_test" },
      requestContext: { connectionId: "gateway-1", routeKey: "$connect" as const },
    };

    await expect(runtime.websocket(connect)).resolves.toEqual({ statusCode: 200 });
    expect(fixture.connections.get("gateway-1")).toMatchObject({
      hostId: "host-1",
      registered: false,
    });
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 403 });
    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "session:ack",
          sessionId: "session-1",
          worktreeId: null,
          attemptId: "attempt-1",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 409 });
    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "host:keepalive",
          hostId: "host-1",
          at: "2026-08-12T00:00:00.000Z",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 409 });
    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "host:register",
          hostId: "other-host",
          worktrees: [],
          commandProfiles: [],
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 403 });

    await expect(
      runtime.websocket({
        body: JSON.stringify({
          type: "host:register",
          hostId: "host-1",
          worktrees: [],
          commandProfiles: [],
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.plane.getHostConnectionId("host-1")).toBe("gateway-1");
    expect(fixture.registrations[0]).toMatchObject({ consumePendingConnection: true });
    expect(fixture.connections.get("gateway-1")?.registered).toBeUndefined();
    expect(JSON.parse(String(fixture.management.send.mock.calls[0]?.[0].input.Data))).toEqual({
      type: "host:registered",
      hostId: "host-1",
      connectionId: "gateway-1",
    });
  });

  it("refreshes durable authentication before accepting a new socket", async () => {
    const fixture = runtimeFixture();
    const refreshAuth = vi.fn(async () => undefined);
    const runtime = await createLambdaRuntime({
      auth: fixture.auth as never,
      created: { plane: fixture.plane, storage: fixture.storage } as never,
      management: fixture.management,
      refreshAuth,
    });

    await runtime.websocket({
      requestContext: { connectionId: "fresh", routeKey: "$connect" },
    });
    expect(refreshAuth).toHaveBeenCalledOnce();
    expect(refreshAuth.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.auth.authenticate.mock.invocationCallOrder[0]!,
    );
  });

  it("awaits direct durable confirmations before completing an invocation", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.management.send.mockClear();
    fixture.sessions.set("session-1", {
      id: "session-1",
      repositoryId: "repository-1",
      prompt: "test",
      target: "default",
      fallbacks: [],
      targetLabels: ["default"],
      timeout: 60,
      priority: 0,
      requiredLabels: [],
      status: "running",
      queueShard: 0,
      createdAt: "2026-08-12T00:00:00.000Z",
      hostId: "host-1",
      worktreeId: null,
      attemptId: "attempt-1",
    });
    let release: (() => void) | undefined;
    fixture.management.send.mockImplementationOnce(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    let settled = false;
    const acknowledgement = runtime
      .websocket({
        body: JSON.stringify({
          type: "session:ack",
          sessionId: "session-1",
          worktreeId: null,
          attemptId: "attempt-1",
        }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      })
      .then((result) => {
        settled = true;
        return result;
      });
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    release!();
    await expect(acknowledgement).resolves.toEqual({ statusCode: 200 });
    expect(JSON.parse(String(fixture.management.send.mock.calls[0]?.[0].input.Data))).toEqual({
      type: "session:acknowledged",
      sessionId: "session-1",
    });

    await expect(
      runtime.websocket({
        body: JSON.stringify({ type: "host:status", hostId: "host-1", draining: true }),
        requestContext: { connectionId: "gateway-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(
      fixture.management.send.mock.calls.map((call) => JSON.parse(String(call[0].input.Data))),
    ).toContainEqual({ type: "host:draining", hostId: "host-1" });
  });

  it("rejects unauthenticated sockets and cleans pending or registered disconnects", async () => {
    const denied = runtimeFixture(null);
    await expect(
      (await denied.runtime).websocket({
        requestContext: { connectionId: "denied", routeKey: "$connect" },
      }),
    ).resolves.toEqual({ statusCode: 403 });

    const fixture = runtimeFixture();
    const runtime = await fixture.runtime;
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "missing", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 401 });
    await runtime.websocket({
      requestContext: { connectionId: "pending", routeKey: "$connect" },
    });
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "pending", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.deletedConnections).toContain("pending");
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "missing", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
  });

  it("lazily creates one shared runtime for all exported handler shapes", async () => {
    const cron = vi.fn(async () => ({
      ackDeadlinesEnforced: 0,
      queuedAssigned: 0,
      scheduledAssigned: 0,
      schedulesFired: 0,
      staleHostsReclaimed: 0,
    }));
    const rest = vi.fn(async () => ({ statusCode: 204 }));
    const websocket = vi.fn(async () => ({ statusCode: 200 }));
    const create = vi.fn(async () => ({ cron, rest, websocket }));
    const handlers = createLambdaHandlers(create);

    await expect(handlers.cron()).resolves.toMatchObject({ schedulesFired: 0 });
    await expect(handlers.rest({})).resolves.toEqual({ statusCode: 204 });
    await expect(
      handlers.websocket({
        requestContext: { connectionId: "one", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("runs a complete durable scheduler sweep and reports its work", async () => {
    const fixture = runtimeFixture();
    const order: string[] = [];
    const refreshSchedulerReadModelDurable = fixture.plane.refreshSchedulerReadModelDurable.bind(
      fixture.plane,
    );
    vi.spyOn(fixture.plane, "evaluateCronDurable").mockImplementation(async () => {
      order.push("cron");
      return [{ id: "scheduled-1" }] as never;
    });
    vi.spyOn(fixture.plane, "enforceAckDeadlinesDurable").mockImplementation(async () => {
      order.push("ack");
      return ["session-1"];
    });
    vi.spyOn(fixture.plane, "refreshSchedulerReadModelDurable").mockImplementation(async () => {
      order.push("refresh");
      await refreshSchedulerReadModelDurable();
    });
    vi.spyOn(fixture.plane, "reclaimStaleHostsDurable").mockImplementation(async () => {
      order.push("stale");
      return ["host-1", "host-2"];
    });
    vi.spyOn(fixture.plane, "assignQueuedDurable").mockImplementation(async () => {
      order.push("queued");
      return [{ session: {}, worktree: {} }] as never;
    });
    vi.spyOn(fixture.plane, "assignScheduledQueuedDurable").mockImplementation(async () => {
      order.push("scheduled");
      return [{ session: {}, hostId: "host-1", worktreeId: null }] as never;
    });

    await expect((await fixture.runtime).cron()).resolves.toEqual({
      ackDeadlinesEnforced: 1,
      queuedAssigned: 1,
      scheduledAssigned: 1,
      schedulesFired: 1,
      staleHostsReclaimed: 2,
    });
    expect(order).toEqual(["cron", "ack", "refresh", "stale", "queued", "scheduled"]);
  });

  it("posts through the management API and prunes gone connections", async () => {
    const fixture = runtimeFixture();
    const runtime = await registerGatewayHost(fixture);
    fixture.management.send.mockClear();

    fixture.plane.drainHost("host-1");
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledTimes(1));
    fixture.management.send.mockRejectedValueOnce({ name: "GoneException" });
    fixture.plane.drainHost("host-1");
    await vi.waitFor(() => expect(fixture.plane.getHostConnectionId("host-1")).toBeUndefined());
    fixture.plane.drainHost("missing");

    await runtime.websocket({
      requestContext: { connectionId: "gateway-2", routeKey: "$connect" },
    });
    await runtime.websocket({
      body: JSON.stringify({
        type: "host:register",
        hostId: "host-1",
        worktrees: [],
        commandProfiles: [],
      }),
      requestContext: { connectionId: "gateway-2", routeKey: "$default" },
    });
    fixture.management.send.mockClear();
    const error = new Error("management unavailable");
    fixture.management.send.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fixture.plane.drainHost("host-1");
    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(
        "failed to deliver API Gateway WebSocket message",
        error,
      ),
    );
    consoleError.mockRestore();
  });

  it("requires the management endpoint only when constructing its AWS client", async () => {
    const fixture = runtimeFixture();
    const previous = process.env.WS_API_ENDPOINT;
    try {
      delete process.env.WS_API_ENDPOINT;
      await expect(
        createLambdaRuntime({
          auth: fixture.auth as never,
          created: { plane: fixture.plane, storage: fixture.storage } as never,
        }),
      ).rejects.toThrow("WS_API_ENDPOINT is required");
      process.env.WS_API_ENDPOINT = "https://example.execute-api.us-east-1.amazonaws.com/prod";
      await expect(
        createLambdaRuntime({
          auth: fixture.auth as never,
          created: { plane: fixture.plane, storage: fixture.storage } as never,
        }),
      ).resolves.toBeDefined();
    } finally {
      if (previous === undefined) delete process.env.WS_API_ENDPOINT;
      else process.env.WS_API_ENDPOINT = previous;
    }
  });
});
