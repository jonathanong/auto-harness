import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/api` as const;

export function getServiceName(): string {
  return serviceName;
}

export { MemorySessionStore } from "./memory-store.ts";
export type { StoredSession } from "./memory-store.ts";
export { createLocalApp, startLocalServer } from "./local-server.ts";
export { createPlaneWsBridge, attachHostWsHub, createWsDelivery } from "./ws-hub.ts";
export { ControlPlane } from "./control-plane.ts";
export type {
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
export { MemorySessionRepository, MemoryWorktreeRepository } from "./db/memory-repos.ts";
export type {
  SessionRecord,
  SessionRepository,
  WorktreeRecord,
  WorktreeRepository,
} from "./db/types.ts";
export {
  Scheduler,
  compareSessionsForQueue,
  compareWorktreesForRoundRobin,
} from "./services/scheduler.ts";
export { main as apiCliMain } from "./cli.ts";
