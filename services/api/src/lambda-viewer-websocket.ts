import {
  GoneException,
  PostToConnectionCommand,
  type ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";

import { mayAccessRepository } from "./auth-policy.ts";
import type { AuthService, Principal } from "./auth.ts";
import type { ConnectionRecord, LogRecord } from "./db/plane-storage-types.ts";
import { parseViewerMessage } from "./viewer-ws-protocol.ts";

const MAX_SUBSCRIPTIONS = 8;
const REPLAY_LIMIT = 250;

type ViewerStorage = {
  deleteConnection(connectionId: string): Promise<void>;
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  getSession(sessionId: string): Promise<{ repositoryId: string; status: string } | null>;
  listConnections(): Promise<ConnectionRecord[]>;
  putConnection(connection: ConnectionRecord): Promise<void>;
  queryLogs(sessionId: string, query: { after?: string; limit: number }): Promise<LogRecord[]>;
};

type ManagementClient = Pick<ApiGatewayManagementApiClient, "send">;
type ViewerDependencies = {
  auth: AuthService;
  management: ManagementClient;
  storage: ViewerStorage;
};

function viewerPrincipal(principal: Principal | null): ConnectionRecord["viewerPrincipal"] {
  if (!principal || (principal.kind !== "admin" && principal.kind !== "user")) return undefined;
  return {
    id: principal.id,
    username: principal.username,
    role: principal.role,
    kind: principal.kind,
    ...(principal.allowedRepositoryIds
      ? { allowedRepositoryIds: principal.allowedRepositoryIds }
      : {}),
  };
}

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

  return {
    async connect(connectionId: string, ticket: string): Promise<number> {
      const principal = viewerPrincipal(await dependencies.auth.authenticateViewerTicket(ticket));
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
      const records = await dependencies.storage.queryLogs(message.sessionId, {
        ...(message.after ? { after: message.after } : {}),
        limit: REPLAY_LIMIT,
      });
      let after = message.after;
      for (const record of records.toSorted((a, b) =>
        a.timestampSeq.localeCompare(b.timestampSeq),
      )) {
        if (!(await post(connectionId, { type: "session:log", ...record }))) return 200;
        after = record.timestampSeq;
      }
      const subscription = {
        sessionId: message.sessionId,
        repositoryId: session.repositoryId,
        status: session.status,
        ...(after ? { after } : {}),
      };
      connection.viewerSubscriptions = existing
        ? subscriptions.map((item) => (item.sessionId === message.sessionId ? subscription : item))
        : [...subscriptions, subscription];
      await save(connection);
      await post(connectionId, {
        type: "session:subscribed",
        sessionId: message.sessionId,
        cursor: after ?? null,
        status: session.status,
      });
      return 200;
    },

    async publishLog(record: LogRecord): Promise<void> {
      for (const connection of await dependencies.storage.listConnections()) {
        if (connection.type !== "client") continue;
        const subscription = connection.viewerSubscriptions?.find(
          ({ sessionId }) => sessionId === record.sessionId,
        );
        if (!subscription || (subscription.after && record.timestampSeq <= subscription.after)) {
          continue;
        }
        if (await post(connection.connectionId, { type: "session:log", ...record })) {
          subscription.after = record.timestampSeq;
          await save(connection);
        }
      }
    },
  };
}
