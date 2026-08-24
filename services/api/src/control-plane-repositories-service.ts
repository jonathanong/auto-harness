import type { RepositoryRecord } from "./db/plane-storage.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import * as repos from "./control-plane-repos.ts";
import * as repositoryPages from "./control-plane-repositories-page.ts";
import * as repositoryAdmission from "./control-plane-repository-admission.ts";
import * as sessionDrains from "./control-plane-session-drains.ts";
import * as durableCatalog from "./control-plane-durable-read-catalog.ts";
import { listRepositoryCountsDurable } from "./control-plane-facade-reads.ts";

/** Repository CRUD, admission, session drains, and aggregate counts. */
export class ControlPlaneRepositoriesService {
  constructor(readonly state: ControlPlaneState) {}

  createRepository(
    input: Parameters<typeof repos.createRepository>[1],
  ): ReturnType<typeof repos.createRepository> {
    return repos.createRepository(this.state, input);
  }

  createRepositoryDurable(
    input: Parameters<typeof repos.createRepository>[1],
  ): Promise<ReturnType<typeof repos.createRepository>> {
    return repos.createRepositoryDurable(this.state, input);
  }

  getRepository(id: string): RepositoryRecord | null {
    return repos.getRepository(this.state, id);
  }

  getRepositoryDurable(id: string): Promise<RepositoryRecord | null> {
    return durableCatalog.getRepositoryDurable(this.state, id);
  }

  listRepositories(): RepositoryRecord[] {
    return repos.listRepositories(this.state);
  }

  listRepositoriesPage(
    query?: repositoryPages.ListRepositoriesPageQuery,
  ): repositoryPages.ListRepositoriesPageResult {
    return repositoryPages.listRepositoriesPage(this.state, query ?? {});
  }

  async listRepositoriesDurable(): Promise<RepositoryRecord[]> {
    await durableCatalog.listRepositoriesDurable(this.state);
    return repos.listRepositories(this.state);
  }

  listRepositoriesPageDurable(
    query?: repositoryPages.ListRepositoriesPageQuery,
  ): Promise<repositoryPages.ListRepositoriesPageResult> {
    return repositoryPages.listRepositoriesPageDurable(this.state, query ?? {});
  }

  updateRepository(
    id: string,
    patch: Parameters<typeof repos.updateRepository>[2],
  ): ReturnType<typeof repos.updateRepository> {
    return repos.updateRepository(this.state, id, patch);
  }

  updateRepositoryDurable(
    id: string,
    patch: Parameters<typeof repos.updateRepository>[2],
  ): Promise<ReturnType<typeof repos.updateRepository>> {
    return repos.updateRepositoryDurable(this.state, id, patch);
  }

  deleteRepository(id: string): ReturnType<typeof repos.deleteRepository> {
    return repos.deleteRepository(this.state, id);
  }

  deleteRepositoryDurable(id: string): Promise<ReturnType<typeof repos.deleteRepository>> {
    return repos.deleteRepositoryDurable(this.state, id);
  }

  pauseRepositoryDurable(id: string) {
    return repositoryAdmission.setRepositoryAdmissionDurable(this.state, id, "paused");
  }

  activateRepositoryDurable(id: string) {
    return repositoryAdmission.setRepositoryAdmissionDurable(this.state, id, "active");
  }

  drainRepositoryDurable(id: string) {
    return repositoryAdmission.drainRepositoryDurable(this.state, id);
  }

  reconcileRepositoryDrainsDurable() {
    return repositoryAdmission.reconcileRepositoryDrainsDurable(this.state);
  }

  createSessionDrainDurable(
    repositoryId: string,
    principalId: string,
    idempotencyKey?: string,
    actor?: import("./audit-types.ts").AuditActor,
  ) {
    return sessionDrains.createSessionDrainDurable(
      this.state,
      repositoryId,
      principalId,
      idempotencyKey,
      actor,
    );
  }

  getSessionDrainDurable(repositoryId: string, principalId: string, operationId: string) {
    return sessionDrains.getSessionDrainDurable(this.state, repositoryId, principalId, operationId);
  }

  reconcileSessionDrainsDurable() {
    return sessionDrains.reconcileSessionDrainsDurable(this.state);
  }

  /** Scheduler-owned, bounded bootstrap. REST/WS cold starts never scan Sessions. */
  migrateSessionDrainActivityLedgerPage(): Promise<boolean> {
    return this.state.storage?.migrateSessionDrainActivityLedgerPage() ?? Promise.resolve(false);
  }

  releaseSessionDrainDurable(
    repositoryId: string,
    principalId: string,
    operationId: string,
    actor?: import("./audit-types.ts").AuditActor,
  ) {
    return sessionDrains.releaseSessionDrainDurable(
      this.state,
      repositoryId,
      principalId,
      operationId,
      actor,
    );
  }

  listRepositoryCountsDurable(
    repositoryIds: readonly string[],
    hostId?: string,
  ): Promise<Map<string, { sessionCount: number; worktreeCount: number; scheduleCount: number }>> {
    return listRepositoryCountsDurable(this.state, repositoryIds, hostId);
  }
}
