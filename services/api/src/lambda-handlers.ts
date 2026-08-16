/* eslint-disable max-lines -- REST, WebSocket, and cron Lambda lifecycles share one runtime. */
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { HostToServerMessage, HostWireMessage } from "@auto-harness/shared";
import { AsyncLocalStorage } from "node:async_hooks";

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
  cron: () => Promise<CronResult>;
  rest: (event: HttpApiEvent) => Promise<HttpApiResponse>;
  websocket: (event: WebSocketEvent) => Promise<{ statusCode: number }>;
};

export type CronResult = {
  ackDeadlinesEnforced: number;
  queuedAssigned: number;
  scheduledAssigned: number;
  schedulesFired: number;
  staleHostsReclaimed: number;
};

export type LambdaRuntimeDependencies = {
  auth?: AuthService;
  created?: PlaneBundle;
  management?: ManagementClient;
  refreshAuth?: () => Promise<void>;
  ssmClient?: SsmClient;
};

export type { HttpApiEvent, HttpApiResponse } from "./lambda-http-adapter.ts";

type SsmClient = Pick<SSMClient, "send">;

type BootstrapSecrets = { admins: string; cursorSecret: string; sessionSecret: string };

/**
 * The three secrets AuthService and the session-cursor signer need. Lambda's environment
 * carries only the SSM parameter *names* (see runtime-stack.ts) — putting the plaintext
 * value directly in a Lambda environment variable would make it readable in cleartext by
 * anyone with lambda:GetFunctionConfiguration and visible in CloudTrail's Lambda-config
 * events. This is deliberately not cached at module scope: createLambdaHandlers already
 * memoizes the whole createLambdaRuntime() call per container, so fetching once per call
 * here is already "once per cold start" — and a function-local fetch is trivial to test,
 * unlike module-level state that would leak between test cases.
 */
export async function loadBootstrapSecrets(client?: SsmClient): Promise<BootstrapSecrets> {
  const ssm = client ?? new SSMClient({});
  const [admins, sessionSecret, cursorSecret] = await Promise.all([
    fetchSecureParameter(ssm, requiredEnv("HARNESS_ADMINS_SSM_PARAM")),
    fetchSecureParameter(ssm, requiredEnv("HARNESS_SESSION_SECRET_SSM_PARAM")),
    fetchSecureParameter(ssm, requiredEnv("HARNESS_CURSOR_SECRET_SSM_PARAM")),
  ]);
  return { admins, cursorSecret, sessionSecret };
}

async function fetchSecureParameter(client: SsmClient, name: string): Promise<string> {
  const response = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = response.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} has no value`);
  return value;
}

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
  const connectionId = plane.getHostConnectionId(hostId);
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
  /* v8 ignore next 4 -- production SSM fetch is exercised through the shared bootstrap-secrets suite */
  const bootstrapSecrets =
    dependencies.created && dependencies.auth
      ? undefined
      : await loadBootstrapSecrets(dependencies.ssmClient);
  /* v8 ignore next 7 -- production AWS client construction is an SDK boundary */
  const created =
    dependencies.created ??
    (await createControlPlane({
      aws: true,
      sessionCursorSecret: bootstrapSecrets!.cursorSecret,
      skipEnsureTables: true,
    }));
  /* v8 ignore next 7 -- production auth construction is exercised through the shared auth suite */
  const auth =
    dependencies.auth ??
    new AuthService({
      admins: bootstrapSecrets!.admins,
      mode: "required",
      secret: bootstrapSecrets!.sessionSecret,
    });
  /* v8 ignore next -- production hydration is exercised through the shared auth/storage suites */
  if (!dependencies.auth) await auth.hydrate(created.storage);
  const management =
    dependencies.management ??
    new ApiGatewayManagementApiClient({ endpoint: requiredEnv("WS_API_ENDPOINT") });
  const deliveryContext = new AsyncLocalStorage<Set<Promise<void>>>();
  const trackDelivery = (hostId: string, message: HostWireMessage): void => {
    const deliveries = deliveryContext.getStore();
    const delivery = postToHost(created.plane, management, hostId, message).catch(
      (error: unknown) => {
        console.error("failed to deliver API Gateway WebSocket message", error);
      },
    );
    if (deliveries) {
      deliveries.add(delivery);
      void delivery.finally(() => deliveries.delete(delivery));
    }
  };
  const runInvocation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const deliveries = new Set<Promise<void>>();
    return deliveryContext.run(deliveries, async () => {
      const result = await operation();
      while (deliveries.size > 0) await Promise.all(deliveries);
      return result;
    });
  };
  created.plane.setOnHostMessage((hostId, message) => {
    trackDelivery(hostId, message);
  });
  const app = createLocalApp({ authService: auth, plane: created.plane, useDynamo: false });

  return {
    async cron() {
      return runInvocation(async () => {
        const schedulesFired = await created.plane.evaluateCronDurable();
        const ackDeadlinesEnforced = await created.plane.enforceAckDeadlinesDurable();
        await created.plane.refreshSchedulerReadModelDurable();
        const staleHostsReclaimed = await created.plane.reclaimStaleHostsDurable();
        const queuedAssigned = await created.plane.assignQueuedDurable();
        const scheduledAssigned = await created.plane.assignScheduledQueuedDurable();
        return {
          ackDeadlinesEnforced: ackDeadlinesEnforced.length,
          queuedAssigned: queuedAssigned.length,
          scheduledAssigned: scheduledAssigned.length,
          schedulesFired: schedulesFired.length,
          staleHostsReclaimed: staleHostsReclaimed.length,
        };
      });
    },
    async rest(event) {
      return runInvocation(async () => {
        const capture = createLambdaResponseCapture();
        await app.handler(requestForLambdaEvent(event), capture.response);
        return capture.result();
      });
    },
    async websocket(event) {
      return runInvocation(async () => {
        const { connectionId, routeKey } = event.requestContext;
        if (routeKey === "$connect") {
          if (dependencies.refreshAuth) await dependencies.refreshAuth();
          /* v8 ignore next -- production refresh uses the shared auth/storage integration */ else if (
            !dependencies.auth
          )
            await auth.hydrate(created.storage);
          const principal = await auth.authenticate(authenticationRequest(event));
          if (!authenticatedHost(principal)) return { statusCode: 403 };
          await created.storage.putConnection({
            connectionId,
            type: "host",
            hostId: principal.boundHostId,
            connectedAt: new Date().toISOString(),
            lastHeartbeatAt: new Date().toISOString(),
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
        if (!message || !validHostMessage(message, authenticated.hostId))
          return { statusCode: 403 };
        const result =
          message.type === "host:register" && authenticated.registered === false
            ? await created.plane.handlePendingHostMessageDurable(message, connectionId)
            : await created.plane.handleHostMessageDurable(
                message,
                connectionId,
                message.type === "host:register",
              );
        if (result.ok && message.type === "host:register") {
          trackDelivery(message.hostId, {
            type: "host:registered",
            hostId: message.hostId,
            connectionId: result.connectionId,
          });
        } else if (result.sessionAcknowledged) {
          trackDelivery(authenticated.hostId, {
            type: "session:acknowledged",
            sessionId: result.sessionAcknowledged,
          });
        } else if (result.hostDraining) {
          trackDelivery(authenticated.hostId, {
            type: "host:draining",
            hostId: result.hostDraining,
          });
        }
        return { statusCode: result.ok ? 200 : 409 };
      });
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
    // A rejected promise is a valid, non-nullish value, so `??=` alone would cache a
    // failed cold start (e.g. an SSM parameter not yet provisioned) forever: every
    // invocation this warm container ever handles again would reject immediately,
    // recoverable only by waiting for AWS to recycle the container. Clear the cache on
    // rejection so the *next* invocation gets a fresh attempt; concurrent callers of
    // this same failed attempt still all see the same rejection, correctly.
    runtime ??= createRuntime().catch((error: unknown) => {
      runtime = undefined;
      throw error;
    });
    return runtime;
  };
  return {
    async cron() {
      return (await getRuntime()).cron();
    },
    async rest(event) {
      return (await getRuntime()).rest(event);
    },
    async websocket(event) {
      return (await getRuntime()).websocket(event);
    },
  };
}

export const { cron, rest, websocket } = createLambdaHandlers();
