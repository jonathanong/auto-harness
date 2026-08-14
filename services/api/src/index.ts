import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/api` as const;

export function getServiceName(): string {
  return serviceName;
}

export { MemorySessionStore } from "./memory-store.ts";
export { configuredArchiveWriter, S3ArchiveWriter } from "./archive-writer.ts";
export type { ArchiveWriter } from "./archive-writer.ts";
export type { StoredSession } from "./memory-store.ts";
export { createLocalApp, startLocalServer } from "./local-server.ts";
export { DEFAULT_LOCAL_SCHEDULER_INTERVAL_MS, LocalScheduler } from "./local-scheduler.ts";
export type { LocalSchedulerOptions } from "./local-scheduler.ts";
export { createPlaneWsBridge, attachHostWsHub, createWsDelivery } from "./ws-hub.ts";
export { ControlPlane } from "./control-plane.ts";
export type {
  ArchiveMetadata,
  ArchiveObject,
  ConnectionRecord,
  ControlPlaneOptions,
  LogRecord,
  PublicSession,
  ScheduleRecord,
  WebhookDelivery,
} from "./control-plane.ts";
export { createControlPlane } from "./create-plane.ts";
export type { CreateControlPlaneOptions } from "./create-plane.ts";
export {
  createDynamoClients,
  createDynamoDocumentClient,
  DEFAULT_DYNAMODB_ENDPOINT,
  tableNames,
} from "./db/dynamo.ts";
export { ensureControlPlaneTables } from "./db/ensure-tables.ts";
export { DynamoPlaneStorage } from "./db/plane-storage.ts";
export type { SessionRecord, WorktreeRecord } from "./db/types.ts";
export {
  createWebhookDelivery,
  DEFAULT_WEBHOOK_MAX_ATTEMPTS,
  MAX_WEBHOOK_ATTEMPTS,
  MAX_WEBHOOK_DUE_QUERY,
} from "./webhook-outbox.ts";
export type {
  DurableWebhookDelivery,
  WebhookDestinationRef,
  WebhookEnqueueInput,
  WebhookEvent,
  WebhookFailureCode,
} from "./webhook-outbox.ts";
export { main as apiCliMain } from "./cli.ts";
