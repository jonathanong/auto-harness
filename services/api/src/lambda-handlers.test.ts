/* eslint-disable max-lines -- Lambda ingress fencing and delivery lifecycle share one fixture. */
import { describe, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import {
  createLambdaHandlers,
  createLambdaRuntime,
  fetchPublicBaseUrl,
  loadBootstrapSecrets,
  type LambdaRuntime,
} from "./lambda-handlers.ts";

function hostPrincipal(hostId = "host-1") {
  return {
    id: "service-1",
    username: "daemon",
    kind: "service-account" as const,
    role: "agent" as const,
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
    async getHostInventory() {
      return null;
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
    async queryLogs() {
      return [];
    },
    async putHostInventory() {},
    async putHostInventoryFenced() {
      return { ok: true };
    },
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
  const auth = {
    authenticate: vi.fn(async () => principal),
    authenticateViewerTicket: vi.fn(async () => ({
      id: "user:viewer",
      username: "viewer",
      kind: "user" as const,
      role: "operator" as const,
      allowedRepositoryIds: ["repository-1"],
    })),
  };
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

  it("routes viewer tickets and read-only messages through the Lambda viewer adapter", async () => {
    const fixture = runtimeFixture();
    fixture.sessions.set("session-1", {
      id: "session-1",
      repositoryId: "repository-1",
      status: "running",
    });
    const runtime = await fixture.runtime;
    await expect(
      runtime.websocket({
        queryStringParameters: { ticket: "viewer-ticket" },
        requestContext: { connectionId: "viewer-1", routeKey: "$connect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.connections.get("viewer-1")).toMatchObject({ type: "client" });
    await expect(
      runtime.websocket({
        body: JSON.stringify({ type: "session:subscribe", sessionId: "session-1" }),
        requestContext: { connectionId: "viewer-1", routeKey: "$default" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(
      JSON.parse(String(fixture.management.send.mock.calls.at(-1)?.[0].input.Data)),
    ).toMatchObject({ type: "session:subscribed", sessionId: "session-1" });
    fixture.management.send.mockClear();
    fixture.plane.state.onLogCommitted?.({
      sessionId: "session-1",
      timestampSeq: "2026-08-12T00:00:01.000Z#0000000001",
      seq: 1,
      stream: "stdout",
      content: "hosted log",
      timestamp: "2026-08-12T00:00:01.000Z",
    });
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fixture.management.send.mock.calls[0]?.[0].input.Data))).toMatchObject(
      {
        type: "session:log",
        sessionId: "session-1",
        content: "hosted log",
      },
    );
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "viewer-1", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(fixture.connections.has("viewer-1")).toBe(false);
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

  it("retries construction on the next invocation instead of caching a failed cold start", async () => {
    // A rejected promise is not null/undefined, so a bare `runtime ??= createRuntime()`
    // would cache the failure forever — every invocation this container ever handles
    // again would reject immediately, e.g. because an SSM bootstrap-secret parameter was
    // not yet provisioned at the container's first cold start.
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("SSM parameter not found"))
      .mockResolvedValueOnce({
        cron: vi.fn(async () => ({
          ackDeadlinesEnforced: 0,
          queuedAssigned: 0,
          scheduledAssigned: 0,
          schedulesFired: 0,
          staleHostsReclaimed: 0,
        })),
        rest: vi.fn(),
        websocket: vi.fn(),
      });
    const handlers = createLambdaHandlers(create);

    await expect(handlers.cron()).rejects.toThrow("SSM parameter not found");
    await expect(handlers.cron()).resolves.toMatchObject({ schedulesFired: 0 });

    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a second concurrent caller of the same failed attempt", async () => {
    let reject!: (error: Error) => void;
    const create = vi.fn(() => new Promise<LambdaRuntime>((_resolve, r) => (reject = r)));
    const handlers = createLambdaHandlers(create);

    const first = handlers.cron();
    const second = handlers.cron();
    reject(new Error("SSM parameter not found"));

    await expect(first).rejects.toThrow("SSM parameter not found");
    await expect(second).rejects.toThrow("SSM parameter not found");
    // Both callers shared the one in-flight attempt; construction still only ran once
    // for this failure, and the *next* invocation after both have settled is what
    // triggers the retry (covered above), not each concurrent caller individually.
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
    vi.spyOn(fixture.plane, "enforceRunningTimeoutsDurable").mockImplementation(async () => {
      order.push("timeout");
      return ["session-2"];
    });
    vi.spyOn(fixture.plane, "refreshSchedulerReadModelDurable").mockImplementation(async () => {
      order.push("refresh");
      await refreshSchedulerReadModelDurable();
    });
    vi.spyOn(fixture.plane, "reclaimStaleHostsDurable").mockImplementation(async () => {
      order.push("stale");
      return ["host-1", "host-2"];
    });
    vi.spyOn(fixture.plane, "reconcileRepositoryDrainsDurable").mockImplementation(async () => {
      order.push("repository-drains");
      return [{ id: "repo-1" }] as never;
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
      runningTimeoutsEnforced: 1,
      queuedAssigned: 1,
      repositoriesReconciled: 1,
      scheduledAssigned: 1,
      schedulesFired: 1,
      staleHostsReclaimed: 2,
    });
    expect(order).toEqual([
      "cron",
      "ack",
      "timeout",
      "refresh",
      "stale",
      "repository-drains",
      "queued",
      "scheduled",
    ]);
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

/**
 * The plaintext env vars this replaced never touched an SDK client at all — they were
 * just process.env reads. Now that the three bootstrap secrets come from SSM, this is
 * the boundary where a wrong parameter name, a missing value, or a missing env var
 * should fail loudly rather than silently constructing an AuthService with an empty
 * secret.
 */
describe("loadBootstrapSecrets", () => {
  const names = [
    "HARNESS_ADMINS_SSM_PARAM",
    "HARNESS_SESSION_SECRET_SSM_PARAM",
    "HARNESS_CURSOR_SECRET_SSM_PARAM",
  ] as const;

  function withEnv<T>(values: Partial<Record<(typeof names)[number], string>>, run: () => T): T {
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) {
        if (values[name] === undefined) delete process.env[name];
        else process.env[name] = values[name];
      }
      return run();
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
    }
  }

  it("fetches all three parameters by name, decrypted, and returns the fetched values", async () => {
    const requests: string[] = [];
    const client = {
      send: vi.fn(async (command: { input: { Name: string; WithDecryption: boolean } }) => {
        requests.push(command.input.Name);
        expect(command.input.WithDecryption).toBe(true);
        return { Parameter: { Value: `value-for-${command.input.Name}` } };
      }),
    };

    const secrets = await withEnv(
      {
        HARNESS_ADMINS_SSM_PARAM: "/auto-harness/admins",
        HARNESS_SESSION_SECRET_SSM_PARAM: "/auto-harness/session-secret",
        HARNESS_CURSOR_SECRET_SSM_PARAM: "/auto-harness/cursor-secret",
      },
      () => loadBootstrapSecrets(client as never),
    );

    expect(secrets).toEqual({
      admins: "value-for-/auto-harness/admins",
      sessionSecret: "value-for-/auto-harness/session-secret",
      cursorSecret: "value-for-/auto-harness/cursor-secret",
    });
    expect(requests.toSorted()).toEqual([
      "/auto-harness/admins",
      "/auto-harness/cursor-secret",
      "/auto-harness/session-secret",
    ]);
  });

  it("fails loudly when a parameter name is not configured", async () => {
    const client = { send: vi.fn() };

    await expect(
      withEnv(
        {
          HARNESS_SESSION_SECRET_SSM_PARAM: "/auto-harness/session-secret",
          HARNESS_CURSOR_SECRET_SSM_PARAM: "/auto-harness/cursor-secret",
        },
        () => loadBootstrapSecrets(client as never),
      ),
    ).rejects.toThrow("HARNESS_ADMINS_SSM_PARAM is required in the Lambda runtime");
  });

  it("fails loudly when SSM returns no value for a parameter", async () => {
    const client = { send: vi.fn(async () => ({ Parameter: {} })) };

    await expect(
      withEnv(
        {
          HARNESS_ADMINS_SSM_PARAM: "/auto-harness/admins",
          HARNESS_SESSION_SECRET_SSM_PARAM: "/auto-harness/session-secret",
          HARNESS_CURSOR_SECRET_SSM_PARAM: "/auto-harness/cursor-secret",
        },
        () => loadBootstrapSecrets(client as never),
      ),
    ).rejects.toThrow("SSM parameter /auto-harness/admins has no value");
  });
});

/**
 * Unlike loadBootstrapSecrets, a missing name, a missing value, and a failed SSM call
 * all fall back to undefined here — this value only ever displays in a session's `url`
 * field and feeds the Slack integration's deep link, never a security boundary, so
 * failing open (ControlPlane's own http://localhost:7421 default then applies) is
 * correct where the bootstrap secrets deliberately fail closed instead.
 */
function withPublicBaseUrlParamEnv<T>(value: string | undefined, run: () => T): T {
  const previous = process.env.PUBLIC_BASE_URL_SSM_PARAM;
  try {
    if (value === undefined) delete process.env.PUBLIC_BASE_URL_SSM_PARAM;
    else process.env.PUBLIC_BASE_URL_SSM_PARAM = value;
    return run();
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_BASE_URL_SSM_PARAM;
    else process.env.PUBLIC_BASE_URL_SSM_PARAM = previous;
  }
}

describe("fetchPublicBaseUrl", () => {
  it("fetches the published URL by name, without decryption", async () => {
    const client = {
      send: vi.fn(async (command: { input: { Name: string; WithDecryption?: boolean } }) => {
        expect(command.input.Name).toBe("/auto-harness/qa/public-base-url");
        expect(command.input.WithDecryption).toBeUndefined();
        return { Parameter: { Value: "https://d1234.cloudfront.net" } };
      }),
    };

    const url = await withPublicBaseUrlParamEnv("/auto-harness/qa/public-base-url", () =>
      fetchPublicBaseUrl(client as never),
    );

    expect(url).toBe("https://d1234.cloudfront.net");
  });

  it("returns undefined when the parameter name is not configured", async () => {
    const client = { send: vi.fn() };

    const url = await withPublicBaseUrlParamEnv(undefined, () =>
      fetchPublicBaseUrl(client as never),
    );

    expect(url).toBeUndefined();
    expect(client.send).not.toHaveBeenCalled();
  });

  it("returns undefined when SSM has no value, or the call fails", async () => {
    const noValue = { send: vi.fn(async () => ({ Parameter: {} })) };
    await expect(
      withPublicBaseUrlParamEnv("/auto-harness/qa/public-base-url", () =>
        fetchPublicBaseUrl(noValue as never),
      ),
    ).resolves.toBeUndefined();

    const failing = { send: vi.fn(async () => Promise.reject(new Error("ParameterNotFound"))) };
    await expect(
      withPublicBaseUrlParamEnv("/auto-harness/qa/public-base-url", () =>
        fetchPublicBaseUrl(failing as never),
      ),
    ).resolves.toBeUndefined();
  });
});
