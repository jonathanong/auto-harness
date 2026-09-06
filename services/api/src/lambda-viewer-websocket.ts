import {
  GoneException,
  PostToConnectionCommand,
  type ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";

import { mayAccessRepository } from "./auth-policy.ts";
import type { AuthService } from "./auth.ts";
import type { ConnectionRecord, LogRecord } from "./db/plane-storage-types.ts";
import {
  addViewerFanout,
  removeViewerFanout,
  viewerConnectionIds,
} from "./lambda-viewer-fanout.ts";
import { viewerConnectionPrincipal } from "./viewer-principal.ts";
import { isAllowedViewerOrigin, parseViewerMessage } from "./viewer-ws-protocol.ts";

const MAX_SUBSCRIPTIONS = 8;

type ViewerStorage = {
  deleteConnection(connectionId: string): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  getSession(sessionId: string): Promise<{ repositoryId: string; status: string } | null>;
  listConnections(): Promise<ConnectionRecord[]>;
  putConnection(connection: ConnectionRecord): Promise<void>;
  queryLogs?(sessionId: string, query: { after?: string; limit: number }): Promise<LogRecord[]>;
};

type ManagementClient = Pick<ApiGatewayManagementApiClient, "send">;
type ViewerDependencies = {
  auth: AuthService;
  management: ManagementClient;
  storage: ViewerStorage;
  publicBaseUrl?: string;
  /** Retry a missing origin after a transient cold-start SSM miss. */
  resolvePublicBaseUrl?: () => Promise<string | undefined>;
};

/** API Gateway WebSocket adapter for read-only browser log subscriptions. */
export function createLambdaViewerSockets(dependencies: ViewerDependencies) {
  const post = async (connectionId: string, message: object): Promise<boolean> => {
    try {
      await dependencies.management.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(JSON.stringify(message)),
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof GoneException || (error as { name?: string }).name === "GoneException") {
        await dependencies.storage.deleteConnection(connectionId);
        return false;
      }
      throw error;
    }
  };

  const save = async (connection: ConnectionRecord): Promise<void> => {
    await dependencies.storage.putConnection(connection);
  };
  let allowedOrigin = dependencies.publicBaseUrl;
  let inflightOrigin: Promise<string | undefined> | undefined;
  let nextOriginRetryAt = 0;
  const viewerOrigin = async (): Promise<string | undefined> => {
    if (allowedOrigin !== undefined) return allowedOrigin;
    if (inflightOrigin) return inflightOrigin;
    if (Date.now() < nextOriginRetryAt) return undefined;
    inflightOrigin = (async () => {
      const resolved = await dependencies.resolvePublicBaseUrl?.();
      if (resolved !== undefined) {
        allowedOrigin = resolved;
        return resolved;
      }
      nextOriginRetryAt = Date.now() + 5_000;
      return undefined;
    })().finally(() => {
      inflightOrigin = undefined;
    });
    return inflightOrigin;
  };

  return {
    async connect(connectionId: string, ticket: string, origin?: string): Promise<number> {
      if (!isAllowedViewerOrigin(origin, await viewerOrigin())) return 403;
      const principal = viewerConnectionPrincipal(
        await dependencies.auth.authenticateViewerTicket(ticket),
      );
      if (!principal) return 403;
      const now = new Date().toISOString();
      await save({
        connectionId,
        type: "client",
        hostId: principal.id,
        connectedAt: now,
        lastHeartbeatAt: now,
        viewerPrincipal: principal,
        viewerSubscriptions: [],
      });
      return 200;
    },

    async disconnect(connectionId: string): Promise<boolean> {
      const connection = await dependencies.storage.getConnection(connectionId);
      if (connection?.type !== "client") return false;
      for (const subscription of connection.viewerSubscriptions ?? []) {
        await removeViewerFanout(dependencies.storage, subscription.sessionId, connectionId);
      }
      await dependencies.storage.deleteConnection(connectionId);
      return true;
    },

    async message(connectionId: string, body: string): Promise<number | undefined> {
      const connection = await dependencies.storage.getConnection(connectionId);
      if (connection?.type !== "client" || !connection.viewerPrincipal) return undefined;
      const message = parseViewerMessage(body);
      if (!message) return 403;
      const subscriptions = connection.viewerSubscriptions ?? [];
      if (message.type === "session:unsubscribe") {
        connection.viewerSubscriptions = subscriptions.filter(
          ({ sessionId }) => sessionId !== message.sessionId,
        );
        await save(connection);
        await removeViewerFanout(dependencies.storage, message.sessionId, connectionId);
        return 200;
      }
      const session = await dependencies.storage.getSession(message.sessionId);
      if (!session || !mayAccessRepository(connection.viewerPrincipal, session.repositoryId)) {
        await post(connectionId, {
          type: "session:error",
          code: "NOT_FOUND",
          sessionId: message.sessionId,
        });
        return 200;
      }
      const existing = subscriptions.find(({ sessionId }) => sessionId === message.sessionId);
      if (!existing && subscriptions.length >= MAX_SUBSCRIPTIONS) {
        await post(connectionId, {
          type: "session:error",
          code: "SUBSCRIPTION_LIMIT",
          sessionId: message.sessionId,
        });
        return 200;
      }
      const subscription = {
        sessionId: message.sessionId,
        repositoryId: session.repositoryId,
        status: session.status,
        ...(message.after ? { after: message.after } : {}),
      };
      connection.viewerSubscriptions = existing
        ? subscriptions.map((item) => (item.sessionId === message.sessionId ? subscription : item))
        : [...subscriptions, subscription];
      await save(connection);
      await addViewerFanout(dependencies.storage, message.sessionId, connectionId);
      if (
        !(await post(connectionId, {
          type: "session:subscribed",
          sessionId: message.sessionId,
          cursor: message.after ?? null,
          status: session.status,
        }))
      ) {
        await removeViewerFanout(dependencies.storage, message.sessionId, connectionId);
      }
      return 200;
    },

    async publishLog(record: LogRecord): Promise<void> {
      for (const viewerId of await viewerConnectionIds(dependencies.storage, record.sessionId)) {
        const connection = await dependencies.storage.getConnection(viewerId);
        if (connection?.type !== "client") continue;
        const subscription = connection.viewerSubscriptions?.find(
          ({ sessionId }) => sessionId === record.sessionId,
        );
        if (!subscription || (subscription.after && record.timestampSeq <= subscription.after)) {
          continue;
        }
        if (!(await post(viewerId, { type: "session:log", ...record }))) {
          await removeViewerFanout(dependencies.storage, record.sessionId, viewerId);
        }
      }
    },
  };
}
