import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/api` as const;

export function getServiceName(): string {
  return serviceName;
}

export { MemorySessionStore } from "./memory-store.js";
export type { StoredSession } from "./memory-store.js";
export { createLocalApp, startLocalServer } from "./local-server.js";
export { createPlaneWsBridge, attachAgentWsHub, createWsDelivery } from "./ws-hub.js";
export { ControlPlane } from "./control-plane.js";
export type {
  ArchiveObject,
  ConnectionRecord,
  ControlPlaneOptions,
  LogRecord,
  PublicSession,
  ScheduleRecord,
  WebhookDelivery,
} from "./control-plane.js";
export { createControlPlane } from "./create-plane.js";
export type { CreateControlPlaneOptions } from "./create-plane.js";
export {
  createDynamoClients,
  createDynamoDocumentClient,
  DEFAULT_DYNAMODB_ENDPOINT,
  tableNames,
} from "./db/dynamo.js";
export { ensureControlPlaneTables } from "./db/ensure-tables.js";
export { DynamoPlaneStorage } from "./db/plane-storage.js";
export { MemorySessionRepository, MemoryWorktreeRepository } from "./db/memory-repos.js";
export type {
  SessionRecord,
  SessionRepository,
  WorktreeRecord,
  WorktreeRepository,
} from "./db/types.js";
export {
  Scheduler,
  compareSessionsForQueue,
  compareWorktreesForRoundRobin,
} from "./services/scheduler.js";
export { main as apiCliMain } from "./cli.js";
