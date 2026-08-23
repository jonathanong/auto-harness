import { createDynamoClients, tableNames, type CreateDynamoClientOptions } from "./db/dynamo.ts";
import { ensureSessionDrainActivityLedger } from "./db/ensure-session-drain-ledger.ts";
import { ensureControlPlaneTables } from "./db/ensure-tables.ts";
import { DynamoPlaneStorage } from "./db/plane-storage.ts";
import { ControlPlane, type ControlPlaneOptions } from "./control-plane.ts";
import { configuredSecretEncryptor } from "./secret-crypto.ts";
import { configuredArchiveWriter } from "./archive-writer.ts";

export type CreateControlPlaneOptions = ControlPlaneOptions &
  CreateDynamoClientOptions & {
    /** Table name prefix (default AutoHarness or HARNESS_DDB_PREFIX). */
    tablePrefix?: string;
    /** Skip CreateTable (tables already ensured). */
    skipEnsureTables?: boolean;
    /** Use AWS's regional DynamoDB endpoint and credential provider chain. */
    aws?: boolean;
  };

/**
 * Build a ControlPlane backed by DynamoDB Local (or AWS when endpoint/creds set).
 * This is the supported local persistence path — not an in-memory store.
 */
export async function createControlPlane(
  options: CreateControlPlaneOptions = {},
): Promise<{ plane: ControlPlane; storage: DynamoPlaneStorage }> {
  const { client, doc } = createDynamoClients({
    ...(options.endpoint !== undefined
      ? { endpoint: options.endpoint }
      : options.aws
        ? { endpoint: null }
        : {}),
    ...(options.region !== undefined ? { region: options.region } : {}),
  });
  const prefix = options.tablePrefix ?? process.env.HARNESS_DDB_PREFIX ?? "AutoHarness";
  const tables = tableNames(prefix);
  if (!options.skipEnsureTables) {
    await ensureControlPlaneTables({ client, prefix });
  } else {
    // AWS tables are provisioned by CDK, so Lambda skips CreateTable. It still
    // must establish the one-time strongly-consistent drain-ledger boundary.
    await ensureSessionDrainActivityLedger(doc, {
      sessions: tables.sessions,
      sessionDrains: tables.sessionDrains,
    });
  }
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
    ...(options.sessionDrainIdFactory !== undefined
      ? { sessionDrainIdFactory: options.sessionDrainIdFactory }
      : {}),
    ...(options.sessionDrainTimeoutMs !== undefined
      ? { sessionDrainTimeoutMs: options.sessionDrainTimeoutMs }
      : {}),
    ...(options.usageLimitRetryCeiling !== undefined
      ? { usageLimitRetryCeiling: options.usageLimitRetryCeiling }
      : {}),
    ...(options.archivePrefix !== undefined ? { archivePrefix: options.archivePrefix } : {}),
    archiveWriter: options.archiveWriter ?? configuredArchiveWriter(),
    ...(options.sessionCursorSecret !== undefined
      ? { sessionCursorSecret: options.sessionCursorSecret }
      : {}),
    ...(options.onHostMessage !== undefined ? { onHostMessage: options.onHostMessage } : {}),
    ...(options.secretEncryptor !== undefined
      ? { secretEncryptor: options.secretEncryptor }
      : { secretEncryptor: configuredSecretEncryptor() }),
  });
  await plane.hydrateFromStorage();
  return { plane, storage };
}
