import { PACKAGE_SCOPE } from "@auto-harness/shared";

export const serviceName = `${PACKAGE_SCOPE}/api` as const;

export function getServiceName(): string {
  return serviceName;
}

export { MemorySessionStore } from "./memory-store.js";
export type { StoredSession } from "./memory-store.js";
export { createLocalApp, startLocalServer } from "./local-server.js";
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
