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
  const plane = new ControlPlane();
  const connections = new Map<string, Record<string, unknown>>();
  const storage = {
    deleteConnection: vi.fn(async (id: string) => void connections.delete(id)),
    getConnection: vi.fn(async (id: string) => connections.get(id) ?? null),
    putConnection: vi.fn(async (connection: Record<string, unknown>) => {
      connections.set(String(connection.connectionId), connection);
    }),
  };
  const auth = { authenticate: vi.fn(async () => principal) };
  const management = { send: vi.fn(async () => ({})) };
  return {
    auth,
    connections,
    management,
    plane,
    runtime: createLambdaRuntime({
      auth: auth as never,
      created: { plane, storage } as never,
      management,
    }),
    storage,
  };
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
    expect(fixture.plane.state.hostConnection.get("host-1")).toBe("gateway-1");
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
    expect(fixture.storage.deleteConnection).toHaveBeenCalledWith("pending");
    await expect(
      runtime.websocket({
        requestContext: { connectionId: "missing", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
  });

  it("lazily creates one shared runtime for both exported handler shapes", async () => {
    const rest = vi.fn(async () => ({ statusCode: 204 }));
    const websocket = vi.fn(async () => ({ statusCode: 200 }));
    const create = vi.fn(async () => ({ rest, websocket }));
    const handlers = createLambdaHandlers(create);

    await expect(handlers.rest({})).resolves.toEqual({ statusCode: 204 });
    await expect(
      handlers.websocket({
        requestContext: { connectionId: "one", routeKey: "$disconnect" },
      }),
    ).resolves.toEqual({ statusCode: 200 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("posts through the management API and prunes gone connections", async () => {
    const fixture = runtimeFixture();
    await fixture.runtime;
    fixture.plane.state.hostConnection.set("host-1", "gateway-1");
    fixture.plane.state.connections.set("gateway-1", {
      connectionId: "gateway-1",
      type: "host",
      hostId: "host-1",
      connectedAt: "2026-08-12T00:00:00.000Z",
      lastHeartbeatAt: "2026-08-12T00:00:00.000Z",
      commandProfiles: [],
    });

    fixture.plane.state.onHostMessage?.("host-1", { type: "host:drain" });
    await vi.waitFor(() => expect(fixture.management.send).toHaveBeenCalledTimes(1));
    fixture.management.send.mockRejectedValueOnce({ name: "GoneException" });
    fixture.plane.state.onHostMessage?.("host-1", { type: "host:drain" });
    await vi.waitFor(() => expect(fixture.plane.state.hostConnection.has("host-1")).toBe(false));
    fixture.plane.state.onHostMessage?.("missing", { type: "host:drain" });

    fixture.plane.state.hostConnection.set("host-1", "gateway-2");
    const error = new Error("management unavailable");
    fixture.management.send.mockRejectedValueOnce(error);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fixture.plane.state.onHostMessage?.("host-1", { type: "host:drain" });
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
    if (previous === undefined) delete process.env.WS_API_ENDPOINT;
    else process.env.WS_API_ENDPOINT = previous;
  });
});
