import { createDynamoClients, tableNames, type CreateDynamoClientOptions } from "./db/dynamo.ts";
import { ensureControlPlaneTables } from "./db/ensure-tables.ts";
import { DynamoPlaneStorage } from "./db/plane-storage.ts";
import { ControlPlane, type ControlPlaneOptions } from "./control-plane.ts";

export type CreateControlPlaneOptions = ControlPlaneOptions &
  CreateDynamoClientOptions & {
    /** Table name prefix (default AutoHarness or HARNESS_DDB_PREFIX). */
    tablePrefix?: string;
    /** Skip CreateTable (tables already ensured). */
    skipEnsureTables?: boolean;
  };

/**
 * Build a ControlPlane backed by DynamoDB Local (or AWS when endpoint/creds set).
 * This is the supported local persistence path — not an in-memory store.
 */
export async function createControlPlane(
  options: CreateControlPlaneOptions = {},
): Promise<{ plane: ControlPlane; storage: DynamoPlaneStorage }> {
  const { client, doc } = createDynamoClients({
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
  });
  const prefix = options.tablePrefix ?? process.env.HARNESS_DDB_PREFIX ?? "AutoHarness";
  if (!options.skipEnsureTables) {
    await ensureControlPlaneTables({ client, prefix });
  }
  const tables = tableNames(prefix);
  const storage = new DynamoPlaneStorage(doc, tables);
  const plane = new ControlPlane({
    storage,
    ...(options.publicBaseUrl !== undefined ? { publicBaseUrl: options.publicBaseUrl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.idFactory !== undefined ? { idFactory: options.idFactory } : {}),
    ...(options.connectionIdFactory !== undefined
      ? { connectionIdFactory: options.connectionIdFactory }
      : {}),
    ...(options.scheduleIdFactory !== undefined
      ? { scheduleIdFactory: options.scheduleIdFactory }
      : {}),
    ...(options.repositoryIdFactory !== undefined
      ? { repositoryIdFactory: options.repositoryIdFactory }
      : {}),
    ...(options.shardCount !== undefined ? { shardCount: options.shardCount } : {}),
    ...(options.ackDeadlineMs !== undefined ? { ackDeadlineMs: options.ackDeadlineMs } : {}),
    ...(options.heartbeatStaleMs !== undefined
      ? { heartbeatStaleMs: options.heartbeatStaleMs }
      : {}),
    ...(options.reconnectGraceMs !== undefined
      ? { reconnectGraceMs: options.reconnectGraceMs }
      : {}),
    ...(options.usageLimitRetryCeiling !== undefined
      ? { usageLimitRetryCeiling: options.usageLimitRetryCeiling }
      : {}),
    ...(options.archivePrefix !== undefined ? { archivePrefix: options.archivePrefix } : {}),
    ...(options.webhookUrl !== undefined ? { webhookUrl: options.webhookUrl } : {}),
    ...(options.onHostMessage !== undefined ? { onHostMessage: options.onHostMessage } : {}),
  });
  await plane.hydrateFromStorage();
  return { plane, storage };
}
