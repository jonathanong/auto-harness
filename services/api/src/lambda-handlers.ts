import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";

import { AuthService, type Principal } from "./auth.ts";
import { createControlPlane } from "./create-plane.ts";
import { createLocalApp } from "./local-app.ts";
import { parseHostMessage } from "./ws-hub.ts";

import {
  createLambdaResponseCapture,
  eventHeaders,
  requestForLambdaEvent,
  type HttpApiEvent,
  type HttpApiResponse,
} from "./lambda-http-adapter.ts";

type HeaderMap = Record<string, string | undefined>;

export type WebSocketEvent = {
  body?: string | null;
  headers?: HeaderMap;
  requestContext: { connectionId: string; routeKey: "$connect" | "$disconnect" | "$default" };
};

type PlaneBundle = Awaited<ReturnType<typeof createControlPlane>>;
type ManagementClient = Pick<ApiGatewayManagementApiClient, "send">;

export type LambdaRuntime = {
  rest: (event: HttpApiEvent) => Promise<HttpApiResponse>;
  websocket: (event: WebSocketEvent) => Promise<{ statusCode: number }>;
};

export type LambdaRuntimeDependencies = {
  auth?: AuthService;
  created?: PlaneBundle;
  management?: ManagementClient;
};

export type { HttpApiEvent, HttpApiResponse } from "./lambda-http-adapter.ts";

function authenticationRequest(event: {
  headers?: HeaderMap;
}): import("node:http").IncomingMessage {
  return { headers: eventHeaders(event) } as import("node:http").IncomingMessage;
}

function authenticatedHost(
  principal: Principal | null,
): principal is Principal & { boundHostId: string } {
  return Boolean(
    principal?.kind === "service-account" &&
    principal.role !== "read-only" &&
    principal.boundHostId,
  );
}

function validHostMessage(message: HostToServerMessage, boundHostId: string): boolean {
  return "hostId" in message ? message.hostId === boundHostId : true;
}

async function postToHost(
  plane: PlaneBundle["plane"],
  management: ManagementClient,
  hostId: string,
  message: HostWireMessage,
): Promise<void> {
  const connectionId = plane.state.hostConnection.get(hostId);
  if (!connectionId) return;
  try {
    await management.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      }),
    );
  } catch (error) {
    if (error instanceof GoneException || (error as { name?: string }).name === "GoneException") {
      await plane.disconnectHostDurable(connectionId);
      return;
    }
    throw error;
  }
}

/** Create the AWS event adapters without performing any deployment. */
export async function createLambdaRuntime(
  dependencies: LambdaRuntimeDependencies = {},
): Promise<LambdaRuntime> {
  /* v8 ignore next 2 -- production AWS client construction is an SDK boundary */
  const created =
    dependencies.created ?? (await createControlPlane({ aws: true, skipEnsureTables: true }));
  /* v8 ignore next -- production auth construction is exercised through the shared auth suite */
  const auth = dependencies.auth ?? new AuthService({ mode: "required" });
  /* v8 ignore next -- production hydration is exercised through the shared auth/storage suites */
  if (!dependencies.auth) await auth.hydrate(created.storage);
  const management =
    dependencies.management ??
    new ApiGatewayManagementApiClient({ endpoint: requiredEnv("WS_API_ENDPOINT") });
  created.plane.setOnHostMessage((hostId, message) => {
    void postToHost(created.plane, management, hostId, message).catch((error: unknown) => {
      console.error("failed to deliver API Gateway WebSocket message", error);
    });
  });
  const app = createLocalApp({ authService: auth, plane: created.plane, useDynamo: false });

  return {
    async rest(event) {
      const capture = createLambdaResponseCapture();
      await app.handler(requestForLambdaEvent(event), capture.response);
      return capture.result();
    },
    async websocket(event) {
      const { connectionId, routeKey } = event.requestContext;
      if (routeKey === "$connect") {
        const principal = await auth.authenticate(authenticationRequest(event));
        if (!authenticatedHost(principal)) return { statusCode: 403 };
        await created.storage.putConnection({
          connectionId,
          type: "host",
          hostId: principal.boundHostId,
          connectedAt: new Date().toISOString(),
          lastHeartbeatAt: new Date().toISOString(),
          commandProfiles: [],
          registered: false,
        });
        return { statusCode: 200 };
      }
      const authenticated = await created.storage.getConnection(connectionId);
      if (routeKey === "$disconnect") {
        if (authenticated?.registered === false)
          await created.storage.deleteConnection(connectionId);
        else await created.plane.disconnectHostDurable(connectionId);
        return { statusCode: 200 };
      }
      if (!authenticated) return { statusCode: 401 };
      const message = parseHostMessage(event.body ?? "");
      if (!message || !validHostMessage(message, authenticated.hostId)) return { statusCode: 403 };
      if (message.type === "host:register" && authenticated.registered === false) {
        await created.storage.deleteConnection(connectionId);
      }
      const result = await created.plane.handleHostMessageDurable(
        message,
        connectionId,
        message.type === "host:register",
      );
      return { statusCode: result.ok ? 200 : 409 };
    },
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required in the Lambda runtime`);
  return value;
}

export function createLambdaHandlers(
  createRuntime: () => Promise<LambdaRuntime> = createLambdaRuntime,
): LambdaRuntime {
  let runtime: Promise<LambdaRuntime> | undefined;
  const getRuntime = (): Promise<LambdaRuntime> => {
    runtime ??= createRuntime();
    return runtime;
  };
  return {
    async rest(event) {
      return (await getRuntime()).rest(event);
    },
    async websocket(event) {
      return (await getRuntime()).websocket(event);
    },
  };
}

export const { rest, websocket } = createLambdaHandlers();
